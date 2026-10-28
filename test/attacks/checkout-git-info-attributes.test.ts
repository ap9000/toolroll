/**
 * Attack: a filter driver named from `.git/info/attributes`, planted after the config was inspected (security review
 * of 0.9.75). --attr-source only replaces the worktree's .gitattributes: git still reads the common directory's
 * info/attributes, and it reads the config again as it starts. An agent that adds `filter.evil.clean` to the
 * checkout's config and `* filter=evil` to info/attributes between the inspection and the run would have git run its
 * command on the host. Every read of an agent-written checkout runs against a private view of the repository (its
 * config as inspected, no info/attributes), so the plant is never read: in a plain checkout or a linked worktree, on
 * the sync path (page reads, handoff) and the async one (the code page's changes).
 */
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const race = vi.hoisted(() => ({ plant: null as null | (() => void) }));
vi.mock("node:child_process", async original => {
  const real = await original<typeof import("node:child_process")>();
  // The moment between the inspection and the read: right after `git config --list` answers, the agent plants.
  const spawnSync = ((...args: Parameters<typeof real.spawnSync>) => {
    const ran = real.spawnSync(...args);
    const argv = Array.isArray(args[1]) ? args[1] as string[] : [];
    if (argv.includes("config") && argv.includes("--show-scope") && race.plant !== null) { race.plant(); race.plant = null; }
    return ran;
  }) as typeof real.spawnSync;
  return { ...real, spawnSync, default: { ...real, spawnSync } };
});

import { execFileSync } from "node:child_process";
import { run } from "../../src/exec.js";
import { checkoutGit, checkoutGitSync } from "../../src/teardown-git.js";
import type { Runner } from "../../src/worktree.js";

let root: string, main: string, linked: string, marker: string;
const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const git = (at: string, ...args: string[]) => execFileSync("git", ["-C", at, ...args], { env, stdio: "pipe" });
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "so-gitinfoattr-")));
  main = join(root, "main"); linked = join(root, "linked"); marker = join(root, "ran");
  execFileSync("git", ["init", "-q", main], { env });
  writeFileSync(join(main, "a.txt"), "one\n");
  git(main, "add", "a.txt");
  git(main, "-c", "user.email=a@b", "-c", "user.name=a", "commit", "-qm", "one");
  git(main, "worktree", "add", "-q", linked);
  writeFileSync(join(main, "a.txt"), "two\n");
  writeFileSync(join(linked, "a.txt"), "two\n");
});
afterEach(() => { race.plant = null; rmSync(root, { recursive: true, force: true }); });

const driver = () => `sh -c 'touch ${marker}; cat'`;
const common = () => join(main, ".git");
/** The probe: a filter in the repository's config, and info/attributes naming it for every path. */
const viaConfig = () => {
  git(main, "config", "filter.evil.clean", driver());
  git(main, "config", "filter.evil.process", `sh -c 'touch ${marker}'`);
  mkdirSync(join(common(), "info"), { recursive: true });
  writeFileSync(join(common(), "info", "attributes"), "* filter=evil\n");
};
/** The same, with the filter in a linked worktree's config.worktree (worktreeConfig already on when inspected). */
const viaWorktreeConfig = () => {
  writeFileSync(join(common(), "worktrees", "linked", "config.worktree"), `[filter "evil"]\n\tclean = "${driver()}"\n`);
  mkdirSync(join(common(), "info"), { recursive: true });
  writeFileSync(join(common(), "info", "attributes"), "* filter=evil\n");
};

const READS = [["status", "--porcelain=v1", "-z", "--untracked-files=all"], ["diff", "HEAD"], ["diff", "--name-only", "HEAD"]];
const cases = [
  ["a plain checkout", () => main, viaConfig, () => {}],
  ["a linked worktree", () => linked, viaConfig, () => {}],
  ["a linked worktree's config.worktree", () => linked, viaWorktreeConfig, () => git(main, "config", "extensions.worktreeConfig", "true")],
] as const;

describe("attack: a filter named by info/attributes, planted between the inspection and the read", () => {
  test("control: the probe runs its command under the page-read flags alone", () => {
    viaConfig();
    try { execFileSync("git", ["--no-lazy-fetch", "--attr-source=4b825dc642cb6eb9a060e54bf8d69288fbee4904", "-c", "core.attributesFile=/dev/null", "status", "--short"], { cwd: main, env, stdio: "pipe" }); } catch { /* the process driver speaks no protocol */ }
    expect(existsSync(marker)).toBe(true);
  });

  for (const [name, at, plant, before] of cases) {
    test(`${name}, sync: status and diff run no filter`, () => {
      before();
      // A plain read reads: the change is reported.
      expect(checkoutGitSync(at(), ["status", "--porcelain=v1"])).toContain("a.txt");
      for (const args of READS) {
        race.plant = plant;
        try { checkoutGitSync(at(), args); } catch { /* a refusal is fine; running the filter is not */ }
        expect(race.plant, "the plant happened after the inspection").toBeNull();
        expect(existsSync(marker), `${name} ${args.join(" ")}`).toBe(false);
      }
    });

    test(`${name}, async (the code page's changes): status and diff run no filter`, async () => {
      before();
      let pending: null | (() => void) = null;
      const inner: Runner = async (file, args, options) => {
        const result = await run(file, args, options);
        if (args.includes("config") && args.includes("--show-scope") && pending !== null) { pending(); pending = null; }
        return result;
      };
      const read = checkoutGit(inner, "read");
      const status = await read("git", ["status", "--porcelain=v1"], { cwd: at(), timeoutMs: 60_000, maxBuffer: 1_048_576 });
      expect(status.stdout).toContain("a.txt");
      for (const args of READS) {
        pending = plant;
        await read("git", args, { cwd: at(), timeoutMs: 60_000, maxBuffer: 1_048_576 });
        expect(pending, "the plant happened after the inspection").toBeNull();
        expect(existsSync(marker), `${name} ${args.join(" ")}`).toBe(false);
      }
    });
  }

  test("the view is invisible to callers: a linked worktree still names its project's common directory", async () => {
    const asked = ["rev-parse", "--path-format=absolute", "--git-common-dir"];
    expect(checkoutGitSync(linked, asked).trim()).toBe(common());
    expect((await checkoutGit(run, "read")("git", asked, { cwd: linked })).stdout.trim()).toBe(common());
  });
});
