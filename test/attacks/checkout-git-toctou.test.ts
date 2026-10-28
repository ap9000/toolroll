/**
 * Attack: the checkout's config gains a filter driver after it was inspected (security review of 01bf3114). A coding
 * checkout is agent-written; checkoutGitSync inspects its config, then runs git, which reads the config again. A
 * filter added in between, with .gitattributes naming it, must never run, on a page read or on a person's POST: every
 * read takes its attributes from the empty tree.
 */
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
import { checkoutGitSync } from "../../src/teardown-git.js";
import { asReadOnlyRequest } from "../../src/read-only-request.js";

let root: string, repo: string, marker: string;
const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { env });
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "so-gittoctou-")));
  repo = join(root, "checkout"); marker = join(root, "ran");
  execFileSync("git", ["init", "-q", repo], { env });
  writeFileSync(join(repo, "a.txt"), "one\n");
  writeFileSync(join(repo, ".gitattributes"), "*.txt filter=x diff=x\n");
  git("add", "a.txt", ".gitattributes");
  git("-c", "user.email=a@b", "-c", "user.name=a", "commit", "-qm", "one");
  writeFileSync(join(repo, "a.txt"), "two\n");
});
afterEach(() => { race.plant = null; rmSync(root, { recursive: true, force: true }); });

describe("attack: a filter driver planted between the inspection and the read", () => {
  const plant = () => {
    git("config", "filter.x.clean", `sh -c 'touch ${marker}; cat'`);
    git("config", "filter.x.process", `sh -c 'touch ${marker}'`);
    git("config", "diff.x.textconv", `sh -c 'touch ${marker}; cat'`);
  };
  for (const [how, around] of [["a person's POST", (work: () => void) => work()], ["a page read", (work: () => void) => asReadOnlyRequest(work)]] as const) {
    test(`${how}: status and diff run no driver`, () => {
      for (const args of [["status", "--porcelain=v1", "-z", "--untracked-files=all"], ["diff", "HEAD"], ["diff", "--name-only", "HEAD"]]) {
        race.plant = plant;
        around(() => { try { checkoutGitSync(repo, args); } catch { /* a refusal is fine; running the driver is not */ } });
        expect(race.plant, "the plant happened after the inspection").toBeNull();
        expect(existsSync(marker), `${how} ${args.join(" ")}`).toBe(false);
        git("config", "--unset-all", "filter.x.clean"); git("config", "--unset-all", "filter.x.process"); git("config", "--unset-all", "diff.x.textconv");
      }
    });
  }
});
