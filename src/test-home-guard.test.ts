import { afterEach, describe, expect, it } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join, sep } from "node:path";
import { gitIncidentRecord } from "./teardown-git.js";
import { buildCacheFolder } from "./agent-fence.js";
import tempRoot from "../test/temp-root.js";

// 2026-11-14: a Flexible thread test's git incident landed in the person's real ~/.toolroll/git-incidents.jsonl. Every
// test file runs with a throwaway HOME (test/setup-state.ts, which never puts the person's back), and a run whose tests
// leave anything named after its temp root in the real home fails at teardown (test/temp-root.ts).

const real = (path: string): string => { try { return realpathSync(path); } catch { return path; } };
const inside = (child: string, parent: string): boolean => child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
const person = [userInfo().homedir, process.env["TOOLROLL_TEST_OUTER_HOME"] ?? ""].filter(Boolean).map(real);

describe("a test file's home", () => {
  it("is a throwaway folder in this run's temp root, never the person's", () => {
    const home = process.env["HOME"]!;
    expect(person).not.toContain(real(home));
    expect(real(homedir())).toBe(real(home));
    expect(inside(real(home), real(tmpdir()))).toBe(true);
  });

  it("is where Toolroll's git incidents, views and build caches go", () => {
    expect(inside(real(gitIncidentRecord()), real(homedir()))).toBe(true);
    expect(inside(buildCacheFolder(tmpdir()), homedir())).toBe(true);
    for (const home of person) expect(inside(real(gitIncidentRecord()), home)).toBe(false);
  });
});

describe("a test run's teardown", () => {
  const made: string[] = [];
  afterEach(() => { for (const one of made.splice(0)) rmSync(one, { recursive: true, force: true }); });

  const run = () => {
    const fake = realpathSync(mkdtempSync(join(tmpdir(), "so-person-")));
    made.push(fake);
    const before = process.env["TMPDIR"];
    const teardown = tempRoot(undefined, { homes: [fake] });
    const root = process.env["TMPDIR"]!;
    process.env["TMPDIR"] = before;
    return { fake, root, teardown };
  };

  it("fails, naming what was left, when a test wrote into the person's home", () => {
    const { fake, root, teardown } = run();
    mkdirSync(join(fake, ".toolroll"), { recursive: true });
    appendFileSync(join(fake, ".toolroll", "git-incidents.jsonl"), `${JSON.stringify({ checkout: join(root, "so-flex-thread-x", "projects", "shop") })}\n`);
    const transcripts = join(fake, ".claude", "projects", `${real(root).replace(/[^a-zA-Z0-9]/g, "-")}-so-flex-thread-x-worktrees-a`);
    mkdirSync(transcripts, { recursive: true });
    expect(() => teardown()).toThrow(/wrote into the person's real home \(2\):.*git-incidents\.jsonl:1/s);
  });

  it("passes when the person's home only changed in ways that aren't this run's", () => {
    const { fake, teardown } = run();
    mkdirSync(join(fake, ".toolroll"), { recursive: true });
    writeFileSync(join(fake, ".toolroll", "git-incidents.jsonl"), `${JSON.stringify({ checkout: "/elsewhere/so-t123456/shop" })}\n`);
    mkdirSync(join(fake, ".claude", "projects", "-Users-someone-Developer-app"), { recursive: true });
    expect(() => teardown()).not.toThrow();
  });
});
