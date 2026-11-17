/**
 * Protect the judges (scripts/gate-changes.mjs, .github/workflows/gate-changes.yml): a pull request that changes a gate
 * file fails unless one of its commits discloses it with a `Gate-change: <file or glob> — <reason>` trailer, and the
 * rules come from the base, never the pull request. A trailer discloses; it approves nothing. Each way around it is
 * one row or one case against real git.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { globMatches, judge, parseGateList, parseTrailers, PATTERN_MAX, plain, printed, readPullRequest, summary, trailerBlock, TRAILERS_MAX } from "../scripts/gate-changes.mjs";

const ROOT = join(import.meta.dirname, "..");
const SCRIPT = join(ROOT, "scripts", "gate-changes.mjs");
const SIGNED = "Co-Authored-By: someone <someone@example.com>";
/** A commit message whose trailer block carries these trailers. */
const withTrailers = (subject: string, ...trailers: string[]) => `${subject}\n\nWhy it changed.\n\n${[...trailers, SIGNED].join("\n")}`;

/**
 * The runner's reading of a job's log: `::stop-commands::<token>` stops command reading until `::<token>::`; outside
 * that, a line starting `::` (after spaces) or holding `##[` anywhere is a command. Returns the commands it would act
 * on, besides the stop and resume themselves.
 */
function commandsActedOn(log: string): string[] {
  const acted: string[] = [];
  let stopped: string | null = null;
  for (const line of log.split(/\r?\n|\r/)) {
    const trimmed = line.trimStart();
    if (stopped !== null) { if (trimmed === `::${stopped}::`) stopped = null; continue; }
    const stop = /^::stop-commands::(.+)$/.exec(trimmed);
    if (stop !== null) { stopped = stop[1]!; continue; }
    if (trimmed.startsWith("::") || line.includes("##[")) acted.push(line);
  }
  return acted;
}

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
    ["a/**/b.json", "a/x/y/b.json", true],
    ["src/*.ts", "src/a.ts", true],
    ["src/*.ts", "src/a/b.ts", false],
    ["src/a.ts", "src/aXts", false],
    ["src/a?.ts", "src/ab.ts", false],
    ["src/[ab].ts", "src/[ab].ts", true],
  ] as const)("%s matches %s: %s", (glob, path, matches) => {
    expect(globMatches(glob, path)).toBe(matches);
  });

  test("a pattern built to backtrack finishes at once: no regular expression, no recursion", () => {
    const pattern = `${"*a".repeat(99)}*b`, path = "a".repeat(5000);
    const started = performance.now();
    expect(globMatches(pattern, path)).toBe(false);
    expect(globMatches(`${"**/".repeat(60)}x`, Array.from({ length: 400 }, () => "a").join("/"))).toBe(false);
    expect(performance.now() - started).toBeLessThan(200);
    expect(PATTERN_MAX).toBe(200);
    expect(pattern.length).toBeLessThanOrEqual(PATTERN_MAX);
  });

  test("only a commit's trailer block (its last paragraph, every line `Key: value`) carries trailers", () => {
    expect(trailerBlock(withTrailers("Subject", "Gate-change: a.json — because"))).toEqual(["Gate-change: a.json — because", SIGNED]);
    // In the body, not the trailer block: not a trailer.
    expect(parseTrailers(`Subject\n\nGate-change: a.json — in the body\n\n${SIGNED}`).trailers).toEqual([]);
    // A last paragraph with prose in it is no trailer block.
    expect(trailerBlock("Subject\n\nGate-change: a.json — reason\nand some prose")).toEqual([]);
    // A subject alone has no trailer block.
    expect(trailerBlock("Gate-change: a.json — a subject is not a trailer")).toEqual([]);
  });

  test("a trailer names a file or glob and a reason; anything less is named as not read and never covers", () => {
    const read = parseTrailers(withTrailers("Raise the wire ceiling",
      "Gate-change: test/perf/wire-ceilings.json — the list now carries its project's name",
      "gate-change: test/destinations.json -- a new page",
      "Gate-change: src/a.ts - x",
      "Gate-change: src/b.ts",
      "Gate-change: ** — everything",
      `Gate-change: ${"a/".repeat(101)}x — too long a pattern`,
      "Gate-change:test/c.json — no space after the colon is fine"));
    expect(read.trailers).toEqual([
      { pattern: "test/perf/wire-ceilings.json", reason: "the list now carries its project's name" },
      { pattern: "test/destinations.json", reason: "a new page" },
      { pattern: "test/c.json", reason: "no space after the colon is fine" },
    ]);
    expect(read.unreadable).toHaveLength(4);
  });

  test(`at most ${TRAILERS_MAX} trailers are read from a pull request`, () => {
    expect(TRAILERS_MAX).toBe(50);
    const many = Array.from({ length: 50 }, (_, at) => `Gate-change: other/${at}.json — filler`);
    const verdict = judge({ gates: [{ path: "a.json", report: false, why: "w" }], changes: [{ status: "M", path: "a.json" }], messages: [withTrailers("x", ...many, "Gate-change: a.json — the real one")] });
    expect(verdict.ok).toBe(false);
    expect(verdict.unreadable.join("\n")).toContain(`more than ${TRAILERS_MAX}`);
  });

  test("the gate list reads whole or not at all (a region, or any other key, is refused)", () => {
    expect(parseGateList(JSON.stringify({ gates: [{ path: "a.json" }, { path: "b/**", report: true, why: "w" }] })))
      .toEqual([{ path: "a.json", report: false, why: "" }, { path: "b/**", report: true, why: "w" }]);
    for (const bad of ["not json", "{}", '{"gates":{}}', '{"gates":[{"path":"**"}]}', '{"gates":[{"path":"/abs"}]}', '{"gates":[{"path":"a","report":"yes"}]}',
      '{"gates":[{"path":"a","regions":[{"from":"x"}]}]}', '{"gates":[{"path":"a","except":"b"}]}']) {
      expect(parseGateList(bad), bad).toBeNull();
    }
  });

  test("this repository's gate list reads, names files that exist, and holds src/release.ts whole", () => {
    const gates = parseGateList(readFileSync(join(ROOT, "scripts", "gate-files.json"), "utf8"));
    expect(gates).not.toBeNull();
    for (const gate of gates!) if (!gate.path.includes("*")) expect(existsSync(join(ROOT, gate.path)), gate.path).toBe(true);
    expect(gates!.filter(one => !one.report).map(one => one.path)).toEqual(expect.arrayContaining(["scripts/gate-files.json", "scripts/gate-changes.mjs", ".github/workflows/**", "src/release.ts"]));
  });

  test.each([
    ["a legacy command anywhere on a line", "##[add-mask]secret"],
    ["an error", "::error::forged"],
    ["set-output", "::set-output name=x::y"],
    ["an escaped newline then a command", "x%0A::warning::y"],
    ["a stop of its own", "::stop-commands::mine"],
    ["a resume of a guessed token", "::deadbeef::"],
    ["a line break, then a command", "x\n::error::y"],
    ["a carriage return, then a command", "x\r::error::y"],
    ["a Unicode line separator, then a command", "x\u2028::error::y"],
  ])("a trailer or path carrying %s is printed where the runner acts on none of it", (_, evil) => {
    const verdict = judge({
      gates: [{ path: "a/**", report: false, why: "w" }],
      changes: [{ status: "M", path: "a/x.json" }, { status: "M", path: `a/${evil}` }],
      messages: [withTrailers("x", `Gate-change: a/x.json — ${evil.replace(/[\n\r]/g, " ")}`, `Gate-change: ${evil.replace(/\s/g, "_")} — ${evil.replace(/[\n\r]/g, " ")}`)],
    });
    const log = printed(verdict);
    // Only this script's own commands: the stop, the resume, and an annotation built from its own words.
    expect(commandsActedOn(log), log).toEqual(["::error::gate changes: a changed gate file has no Gate-change trailer (see the summary)"]);
    // Each run's token is fresh.
    expect(/^::stop-commands::([0-9a-f]{32})$/m.exec(printed(verdict))?.[1]).not.toBe(/^::stop-commands::([0-9a-f]{32})$/m.exec(log)?.[1]);
  });

  test("a plain path is named in its annotation; the pull request's words reach the summary as Markdown text", () => {
    const verdict = judge({ gates: [{ path: "a/**", report: false, why: "w" }], changes: [{ status: "M", path: "a/x.json" }, { status: "M", path: "a/y.json" }],
      messages: [withTrailers("x", "Gate-change: a/y.json — **bold** [link](https://evil.example) `code` <b>")] });
    expect(commandsActedOn(printed(verdict))).toEqual(["::error file=a/x.json::gate changes: a/x.json judges other changes; no Gate-change trailer discloses it"]);
    const text = summary(verdict);
    expect(text).toContain("\\*\\*bold\\*\\* \\[link\\]\\(https://evil\\.example\\) \\`code\\` \\<b\\>");
    expect(plain("a\nb\rc")).toBe("a?b?c");
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
  const check = (from: string, head: string) => {
    const ran = spawnSync(process.execPath, [SCRIPT, "check", "--root", repo, "--base", from, "--head", head], { encoding: "utf8", env });
    return { status: ran.status, out: `${ran.stdout}${ran.stderr}`, head };
  };
  /** A pull request: a branch from the base with these commits, judged by the CLI (exit code and output). */
  const pull = (name: string, commits: { files: Record<string, string | null>; message: string }[]) => {
    git("checkout", "-q", "-B", name, base);
    for (const one of commits) {
      for (const [path, text] of Object.entries(one.files)) {
        if (text === null) git("rm", "-q", path);
        else write(path, text);
      }
      commit(one.message);
    }
    return check(base, git("rev-parse", "HEAD"));
  };

  test("a pull request changing a gate file without a trailer fails, naming the file", () => {
    const got = pull("no-trailer", [{ files: { "test/destinations.json": '{"page":1}\n' }, message: "Add a page" }]);
    expect(got.status).toBe(1);
    expect(got.out).toContain("test/destinations\\.json (every address): **no Gate-change trailer discloses it**");
    expect(got.out).toContain("::error file=test/destinations.json::");
  });

  test("with a trailer in the trailer block of any of its commits (the file or a glob) it passes; one in a body doesn't", () => {
    const exact = pull("trailer", [
      { files: { "test/destinations.json": '{"page":1}\n' }, message: "Add a page" },
      { files: {}, message: withTrailers("Disclose the judge change", "Gate-change: test/destinations.json — the new settings page is a destination") },
    ]);
    expect(exact.status, exact.out).toBe(0);
    expect(exact.out).toContain("disclosed by Gate-change: test/destinations\\.json, the new settings page is a destination");
    const glob = pull("glob", [{ files: { "test/perf/wire-ceilings.json": '{"bytes":120}\n' }, message: withTrailers("Raise it", "Gate-change: test/perf/*.json — the list carries names now") }]);
    expect(glob.status, glob.out).toBe(0);
    const body = pull("body", [{ files: { "test/destinations.json": "[]\n" }, message: `Change it\n\nGate-change: test/destinations.json — written in the body\n\n${SIGNED}` }]);
    expect(body.status).toBe(1);
  });

  test("only the pull request's own commits count: a merge's message is not read", () => {
    // A side branch merged in, whose merge commit carries the trailer; the change itself has none.
    git("checkout", "-q", "-B", "side", base);
    write("src/side.ts", "export const s = 1;\n");
    commit("side work");
    git("checkout", "-q", "-B", "merged", base);
    write("test/destinations.json", "[9]\n");
    commit("Change destinations");
    git("merge", "-q", "--no-ff", "side", "-m", withTrailers("Merge side", "Gate-change: test/destinations.json — said only by a merge"));
    expect(check(base, git("rev-parse", "HEAD")).status).toBe(1);
  });

  test("a pull request that edits the gate list is still judged by the base's list", () => {
    const loosened = { gates: LIST.gates.filter(one => one.path !== "test/destinations.json") };
    const got = pull("loosen", [{
      files: { "scripts/gate-files.json": JSON.stringify(loosened), "test/destinations.json": '{"quiet":1}\n' },
      message: withTrailers("Stop judging destinations", "Gate-change: scripts/gate-files.json — destinations are judged elsewhere now"),
    }]);
    expect(got.status).toBe(1);
    expect(got.out).toContain("test/destinations\\.json (every address): **no Gate-change trailer discloses it**");
    expect(pull("delete-list", [{ files: { "scripts/gate-files.json": null, "test/destinations.json": "[1]\n" }, message: "Remove the list" }]).status).toBe(1);
    // Nor does replacing the head's commit through the checkout's own refs (git replace): the judge reads no replacements.
    const plainHead = pull("plain", [{ files: { "src/app.ts": "export const a = 2;\n" }, message: "ordinary" }]).head;
    const gated = pull("gated", [{ files: { "test/destinations.json": "[2]\n" }, message: "judge change" }]).head;
    git("replace", gated, plainHead);
    const ran = check(base, gated);
    git("replace", "-d", gated);
    expect(ran.status).toBe(1);
  });

  test("a pull request changing no gate file passes; a report-only gate is listed, never failed", () => {
    const got = pull("ordinary", [{ files: { "src/app.ts": "export const a = 3;\n", "test/timings.json": '{"a":1}\n' }, message: "Ordinary change" }]);
    expect(got.status, got.out).toBe(0);
    expect(got.out).toContain("test/timings\\.json (timings): changed; reported only");
  });

  test("a base without a gate list has no gates yet; a head or base that isn't a commit id fails without echoing it as a command", () => {
    expect(readPullRequest(repo, base, base).gatesText).not.toBeNull();
    git("checkout", "-q", "-B", "bare", base);
    git("rm", "-q", "scripts/gate-files.json");
    const bare = commit("no list");
    write("test/destinations.json", "[3]\n");
    const head = commit("change");
    const ran = check(bare, head);
    expect(ran.status).toBe(0);
    expect(ran.out).toContain("no scripts/gate-files.json yet");
    for (const wrong of ["main", "f".repeat(40)]) {
      const refused = check(wrong, head);
      expect(refused.status).toBe(1);
      expect(commandsActedOn(refused.out)).toEqual(["::error::gate changes: the pull request couldn't be read whole"]);
    }
  });
});
