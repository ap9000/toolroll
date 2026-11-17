/**
 * Protect the judges (scripts/gate-changes.mjs, .github/workflows/gate-changes.yml): a pull request that changes a gate
 * file fails unless one of its commits carries `Gate-change: <file or glob> — <reason>` covering it, and the rules come
 * from the base, never the pull request. Each way around it is one row or one case against real git.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { globRegExp, judge, parseGateList, parseTrailers, plain, readPullRequest, regionsOf, summary } from "../scripts/gate-changes.mjs";

const ROOT = join(import.meta.dirname, "..");
const SCRIPT = join(ROOT, "scripts", "gate-changes.mjs");

type Gate = { path: string; report: boolean; why: string; regions?: { from: string; to?: string }[] };

describe("the rules", () => {
  test.each([
    // [glob, path, matches]
    ["test/destinations.json", "test/destinations.json", true],
    ["test/destinations.json", "test/destinations.jsonx", false],
    ["test/perf/*ceilings.json", "test/perf/wire-ceilings.json", true],
    ["test/perf/*ceilings.json", "test/perf/deep/wire-ceilings.json", false],
    [".github/workflows/**", ".github/workflows/ci.yml", true],
    [".github/workflows/**", ".github/workflows/sub/x.yml", true],
    ["tui/**/snapshots/**", "tui/crates/a/tests/snapshots/x.snap", true],
    ["a/**/b.json", "a/b.json", true],
    ["src/?.ts", "src/a.ts", true],
    ["src/?.ts", "src/ab.ts", false],
    ["src/a.ts", "src/aXts", false],
  ] as const)("%s matches %s: %s", (glob, path, matches) => {
    expect(globRegExp(glob).test(path)).toBe(matches);
  });

  test("a trailer names a file or glob and a reason; anything less is named as unreadable and never covers", () => {
    const message = [
      "Raise the wire ceiling for the new list",
      "",
      "Gate-change: test/perf/wire-ceilings.json — the list now carries its project's name",
      "gate-change: test/destinations.json -- a new page",
      "Gate-change: src/a.ts - x",
      "Gate-change: src/b.ts",
      "Gate-change: ** — everything",
      "Gate-change:test/c.json — no space after the colon is fine",
      "  Gate-change: indented.json — not a trailer line",
    ].join("\n");
    const read = parseTrailers(message);
    expect(read.trailers).toEqual([
      { pattern: "test/perf/wire-ceilings.json", reason: "the list now carries its project's name" },
      { pattern: "test/destinations.json", reason: "a new page" },
      { pattern: "test/c.json", reason: "no space after the colon is fine" },
    ]);
    expect(read.unreadable).toEqual(["Gate-change: src/a.ts - x", "Gate-change: src/b.ts", "Gate-change: ** — everything"]);
  });

  test("the gate list reads whole or not at all", () => {
    expect(parseGateList(JSON.stringify({ gates: [{ path: "a.json" }, { path: "b/**", report: true, why: "w" }] })))
      .toEqual([{ path: "a.json", report: false, why: "" }, { path: "b/**", report: true, why: "w" }]);
    for (const bad of ["not json", "{}", '{"gates":{}}', '{"gates":[{"path":"**"}]}', '{"gates":[{"path":"/abs"}]}', '{"gates":[{"path":"a","report":"yes"}]}',
      '{"gates":[{"path":"a","regions":[]}]}', '{"gates":[{"path":"a","regions":[{"from":" "}]}]}', '{"gates":[{"path":"a","regions":[{"from":"x","to":""}]}]}']) {
      expect(parseGateList(bad), bad).toBeNull();
    }
  });

  test("this repository's gate list reads, names files that exist, and every region's anchors are found", () => {
    const gates = parseGateList(readFileSync(join(ROOT, "scripts", "gate-files.json"), "utf8")) as Gate[] | null;
    expect(gates).not.toBeNull();
    for (const gate of gates!) {
      if (/[*?]/.test(gate.path)) continue;
      expect(existsSync(join(ROOT, gate.path)), gate.path).toBe(true);
      if (gate.regions !== undefined) expect(regionsOf(readFileSync(join(ROOT, gate.path), "utf8"), gate.regions), gate.path).not.toBeNull();
    }
    // The list and its script are gates themselves.
    expect(gates!.filter(one => !one.report).map(one => one.path)).toEqual(expect.arrayContaining(["scripts/gate-files.json", "scripts/gate-changes.mjs", ".github/workflows/**"]));
  });

  test("a region gate counts only the parts it names, and a missing anchor counts as changed", () => {
    const gates: Gate[] = [{ path: "src/release.ts", report: false, why: "lists", regions: [{ from: "export const LIST = [", to: "];" }, { from: "export const ONE" }] }];
    const base = "const a = 1;\nexport const LIST = [\n  \"x\",\n];\nexport const ONE = 1;\n";
    const verdict = (after: string | null) => judge({ gates, changes: [{ status: "M", path: "src/release.ts" }], before: () => base, after: () => after, messages: [] });
    expect(verdict(base.replace("const a = 1;", "const a = 2;"))).toMatchObject({ ok: true, required: [] });
    expect(verdict(base.replace('"x"', '"y"'))).toMatchObject({ ok: false, required: [{ path: "src/release.ts", covered: false }] });
    expect(verdict(base.replace("ONE = 1", "ONE = 2"))).toMatchObject({ ok: false });
    expect(verdict(base.replace("export const LIST = [", "export const RENAMED = ["))).toMatchObject({ ok: false });
    expect(verdict(null)).toMatchObject({ ok: false });
  });

  test("a path or trailer from the pull request can't start a line of the summary (a workflow command)", () => {
    const evil = "a\n::add-mask::x\r `";
    expect(plain(evil)).toBe("a?::add-mask::x???");
    const text = summary({ ok: false, required: [{ path: `.github/workflows/${evil}`, why: "w", covered: false }], report: [], unreadable: [`Gate-change: ${evil}`] });
    expect(text.split("\n").filter(line => line.startsWith("::"))).toEqual([]);
  });
});

describe("against real git", () => {
  const dir = mkdtempSync(join(tmpdir(), "gate-changes-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const env = { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: dir, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
  const repo = join(dir, "repo");
  const git = (...args: string[]) => {
    const ran = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...args], { cwd: repo, encoding: "utf8", env });
    if (ran.status !== 0) throw new Error(ran.stderr);
    return ran.stdout.trim();
  };
  const write = (path: string, text: string) => { mkdirSync(dirname(join(repo, path)), { recursive: true }); writeFileSync(join(repo, path), text); };
  const commit = (message: string) => { git("add", "-A"); git("commit", "-q", "--allow-empty", "-m", message); return git("rev-parse", "HEAD"); };
  const LIST = { gates: [
    { path: "scripts/gate-files.json", why: "this list" },
    { path: "test/destinations.json", why: "every address" },
    { path: "test/perf/*ceilings.json", why: "wire ceilings" },
    { path: "test/timings.json", report: true, why: "timings" },
  ] };
  let base = "";
  beforeAll(() => {
    mkdirSync(repo);
    git("init", "-q");
    write("scripts/gate-files.json", JSON.stringify(LIST));
    write("test/destinations.json", "{}\n");
    write("test/perf/wire-ceilings.json", '{"bytes":100}\n');
    write("test/timings.json", "{}\n");
    write("src/app.ts", "export const a = 1;\n");
    base = commit("base");
  });
  /** A pull request: a branch from the base with these commits, judged by the CLI (exit code and summary). */
  const pull = (name: string, commits: { files: Record<string, string | null>; message: string }[]) => {
    git("checkout", "-q", "-B", name, base);
    for (const one of commits) {
      for (const [path, text] of Object.entries(one.files)) {
        if (text === null) git("rm", "-q", path);
        else write(path, text);
      }
      commit(one.message);
    }
    const head = git("rev-parse", "HEAD");
    const ran = spawnSync(process.execPath, [SCRIPT, "check", "--root", repo, "--base", base, "--head", head], { encoding: "utf8", env });
    return { status: ran.status, out: `${ran.stdout}${ran.stderr}`, head };
  };

  test("a pull request changing a gate file without a trailer fails, naming the file", () => {
    const got = pull("no-trailer", [{ files: { "test/destinations.json": '{"page":1}\n' }, message: "Add a page" }]);
    expect(got.status).toBe(1);
    expect(got.out).toContain("`test/destinations.json` (every address): **no Gate-change trailer covers it**");
    expect(got.out).toContain("::error file=test/destinations.json::");
  });

  test("with a trailer in any of its commits (the file or a glob) it passes", () => {
    const exact = pull("trailer", [
      { files: { "test/destinations.json": '{"page":1}\n' }, message: "Add a page" },
      { files: {}, message: "Declare the judge change\n\nGate-change: test/destinations.json — the new settings page is a destination" },
    ]);
    expect(exact.status, exact.out).toBe(0);
    expect(exact.out).toContain("declared by `Gate-change: test/destinations.json` — the new settings page is a destination");
    const glob = pull("glob", [{ files: { "test/perf/wire-ceilings.json": '{"bytes":120}\n' }, message: "Raise it\n\nGate-change: test/perf/*.json — the list carries names now" }]);
    expect(glob.status, glob.out).toBe(0);
    // A trailer for another file, or one with no reason, covers nothing.
    const other = pull("other", [{ files: { "test/destinations.json": "[]\n" }, message: "x\n\nGate-change: test/perf/wire-ceilings.json — unrelated\nGate-change: test/destinations.json" }]);
    expect(other.status).toBe(1);
    expect(other.out).toContain("ignored, unreadable: `Gate-change: test/destinations.json`");
  });

  test("a pull request that edits the gate list is still judged by the base's list", () => {
    // It drops destinations.json from the list (declaring that) and changes destinations.json without a trailer.
    const loosened = { gates: LIST.gates.filter(one => one.path !== "test/destinations.json") };
    const got = pull("loosen", [{
      files: { "scripts/gate-files.json": JSON.stringify(loosened), "test/destinations.json": '{"quiet":1}\n' },
      message: "Stop judging destinations\n\nGate-change: scripts/gate-files.json — destinations are judged elsewhere now",
    }]);
    expect(got.status).toBe(1);
    expect(got.out).toContain("`test/destinations.json` (every address): **no Gate-change trailer covers it**");
    expect(got.out).toContain("declared by `Gate-change: scripts/gate-files.json`");
    // Deleting the list on the pull request doesn't help either.
    expect(pull("delete-list", [{ files: { "scripts/gate-files.json": null, "test/destinations.json": "[1]\n" }, message: "Remove the list" }]).status).toBe(1);
    // Nor does replacing the head's commit through the checkout's own refs (git replace): the judge reads no replacements.
    const plainHead = pull("plain", [{ files: { "src/app.ts": "export const a = 2;\n" }, message: "ordinary" }]).head;
    const gated = pull("gated", [{ files: { "test/destinations.json": "[2]\n" }, message: "judge change" }]).head;
    git("replace", gated, plainHead);
    const ran = spawnSync(process.execPath, [SCRIPT, "check", "--root", repo, "--base", base, "--head", gated], { encoding: "utf8", env });
    git("replace", "-d", gated);
    expect(ran.status).toBe(1);
  });

  test("a pull request changing no gate file passes; a report-only gate is listed, never failed", () => {
    const got = pull("ordinary", [{ files: { "src/app.ts": "export const a = 3;\n", "test/timings.json": '{"a":1}\n' }, message: "Ordinary change" }]);
    expect(got.status, got.out).toBe(0);
    expect(got.out).toContain("`test/timings.json` (timings): changed; reported only");
  });

  test("a base without a gate list has no gates yet; a head or base that isn't a commit id fails", () => {
    const pr = readPullRequest(repo, base, base);
    expect(pr.gatesText).not.toBeNull();
    git("checkout", "-q", "-B", "bare", base);
    git("rm", "-q", "scripts/gate-files.json");
    const bare = commit("no list");
    write("test/destinations.json", "[3]\n");
    const head = commit("change");
    const ran = spawnSync(process.execPath, [SCRIPT, "check", "--root", repo, "--base", bare, "--head", head], { encoding: "utf8", env });
    expect(ran.status).toBe(0);
    expect(ran.stdout).toContain("no scripts/gate-files.json yet");
    expect(spawnSync(process.execPath, [SCRIPT, "check", "--root", repo, "--base", "main", "--head", head], { encoding: "utf8", env }).status).toBe(1);
    expect(spawnSync(process.execPath, [SCRIPT, "check", "--root", repo, "--base", "f".repeat(40), "--head", head], { encoding: "utf8", env }).status).toBe(1);
  });
});
