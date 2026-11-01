/**
 * Attack: repository context (src/repository-context.ts) read an agent-written checkout with plain git outside a page
 * read (a lead's or crew's context call, its refresh): no inspection of the checkout's config, its global and system
 * config read, only hooks and fsmonitor turned off (follow-up to the security review of 0.9.75). A checkout whose
 * config makes it a partial clone with a command for its transport has git run that command on a lazy fetch of a
 * missing commit (the requested base). Every call now goes through checkoutGitSync: the config is inspected in a view
 * of the plane's own, lazy fetch and every protocol are off, and a plant made after the inspection is never read.
 */
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const race = vi.hoisted(() => ({ armed: false, busy: false, plant: null as null | (() => void), unplant: null as null | (() => void), planted: 0 }));
vi.mock("node:child_process", async original => {
  const real = await original<typeof import("node:child_process")>();
  // The window: right after the hardened helper's inspection (`git config --list --show-scope`) the agent plants, and
  // takes it back once the command after it has run, so every command meets the plant in its own window. Plain git
  // (no inspection at all) meets it on every command.
  const isRun = (argv: readonly string[]) => !argv.includes("--file") && !(argv.includes("config") && argv.includes("--show-scope"));
  // The plant's own git (busy) is never itself a window.
  const act = (what: null | (() => void)) => { race.busy = true; try { what?.(); } finally { race.busy = false; } };
  const spawnSync = ((...args: Parameters<typeof real.spawnSync>) => {
    const argv = Array.isArray(args[1]) ? args[1] as string[] : [];
    const ran = real.spawnSync(...args);
    if (race.armed && !race.busy && args[0] === "git") {
      if (argv.includes("config") && argv.includes("--show-scope")) { act(race.plant); race.planted++; }
      else if (isRun(argv)) act(race.unplant);
    }
    return ran;
  }) as typeof real.spawnSync;
  const execFileSync = ((...args: Parameters<typeof real.execFileSync>) => {
    const argv = Array.isArray(args[1]) ? args[1] as string[] : [];
    const plain = race.armed && !race.busy && args[0] === "git" && isRun(argv);
    if (plain) { act(race.plant); race.planted++; }
    try { return real.execFileSync(...args); } finally { if (plain) act(race.unplant); }
  }) as typeof real.execFileSync;
  return { ...real, spawnSync, execFileSync, default: { ...real, spawnSync, execFileSync } };
});

import { execFileSync } from "node:child_process";
import { repositoryContextRead } from "../../src/repository-context.js";

let root: string, repo: string, marker: string;
const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const git = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-C", repo, ...args], { env, stdio: "pipe", encoding: "utf8" });
const MISSING = "1".repeat(40);

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "so-repoctx-")));
  repo = join(root, "checkout"); marker = join(root, "ran");
  execFileSync("git", ["init", "-q", repo], { env });
  writeFileSync(join(repo, "a.ts"), "export const widget = 1;\n");
  git("add", "a.ts");
  git("-c", "user.email=a@b", "-c", "user.name=a", "commit", "-qm", "one");
});
afterEach(() => { race.armed = false; race.plant = race.unplant = null; race.planted = 0; rmSync(root, { recursive: true, force: true }); });

/** The probe: a partial clone whose transport is a command, a filter named for every path by info/attributes, an
 * fsmonitor and a hooks path. */
const PLANTED: [string, string][] = [
  ["core.repositoryformatversion", "1"], ["extensions.partialClone", "origin"], ["remote.origin.promisor", "true"],
  ["remote.origin.url", "ssh://example.invalid/r"], ["core.sshCommand", `sh -c 'touch ${"MARKER"}; exit 1'`],
  ["filter.evil.clean", `sh -c 'touch ${"MARKER"}; cat'`], ["filter.evil.process", `sh -c 'touch ${"MARKER"}'`],
  ["core.fsmonitor", `sh -c 'touch ${"MARKER"}'`],
];
const plant = () => {
  for (const [key, value] of PLANTED) git("config", key, value.replace("MARKER", marker));
  mkdirSync(join(repo, ".git", "info"), { recursive: true });
  writeFileSync(join(repo, ".git", "info", "attributes"), "* filter=evil\n");
};
const unplant = () => {
  for (const [key] of PLANTED) if (key !== "core.repositoryformatversion") { try { git("config", "--unset-all", key); } catch { /* not set */ } }
  rmSync(join(repo, ".git", "info", "attributes"), { force: true });
};

describe("attack: repository context outside a page read runs nothing an agent planted", () => {
  test("control: plain git with hooks and fsmonitor off runs the planted transport on a lazy fetch", () => {
    plant();
    try { execFileSync("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-C", repo, "rev-parse", "--verify", `${MISSING}^{commit}`], { env, stdio: "pipe" }); } catch { /* the commit stays missing */ }
    expect(existsSync(marker)).toBe(true);
  });

  test("planted before the call: refused, nothing runs", () => {
    plant();
    const context = repositoryContextRead({ repo, query: "widget", baseRevision: MISSING });
    expect(context.checkout).toBeNull();
    expect(existsSync(marker)).toBe(false);
  });

  test("planted between each inspection and its command: nothing runs, and the context still reads", () => {
    race.plant = plant; race.unplant = unplant; race.armed = true;
    const missing = repositoryContextRead({ repo, query: "widget", baseRevision: MISSING });
    race.armed = false;
    expect(race.planted, "the plant happened").toBeGreaterThan(0);
    expect(existsSync(marker)).toBe(false);
    expect(missing.checkout).toBeNull();
    race.armed = true;
    const read = repositoryContextRead({ repo, query: "widget" });
    race.armed = false;
    expect(existsSync(marker)).toBe(false);
    expect(read.checkout?.repo).toBe(repo);
    expect(read.excerpts.map(one => one.file)).toEqual(["a.ts"]);
  });
});
