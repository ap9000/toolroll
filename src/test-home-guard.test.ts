import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { delimiter, dirname, join, sep } from "node:path";
import { gitIncidentRecord } from "./teardown-git.js";
import { buildCacheFolder } from "./agent-fence.js";
import { outsideTempDir } from "../test/short-temp.js";
import tempRoot from "../test/temp-root.js";
// @ts-expect-error plain ESM script without declarations
import { AGENT_CLIS, APPROVED_TOOLS } from "../scripts/isolated-env.mjs";

// 2026-11-14: a Flexible thread test's git incident landed in the person's real ~/.toolroll/git-incidents.jsonl. Every
// test worker's environment is rebuilt from nothing (test/setup-state.ts), and a run's teardown runs a limited residue
// check of the real home (test/temp-root.ts).

const real = (path: string): string => { try { return realpathSync(path); } catch { return path; } };
const inside = (child: string, parent: string): boolean => child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
const person = real(userInfo().homedir);

describe("a test worker's environment", () => {
  it("has a throwaway home in this run's temp root, never the person's, and every XDG folder in it", () => {
    const home = process.env["HOME"]!;
    expect(real(home)).not.toBe(person);
    expect(real(homedir())).toBe(real(home));
    expect(inside(real(home), real(tmpdir()))).toBe(true);
    for (const name of ["XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "GIT_CONFIG_GLOBAL"]) expect(inside(real(process.env[name]!), real(home)), name).toBe(true);
    expect(inside(real(dirname(process.env["XDG_CONFIG_HOME"]!)), real(tmpdir()))).toBe(true);
  });

  it("carries no credential, agent session or person's config folder", () => {
    for (const name of Object.keys(process.env)) expect(name, name).not.toMatch(/TOKEN|_KEY$|SECRET(?!_STORE)|PASSWORD|^AWS_|^ANTHROPIC_|^OPENAI_|^CLAUDE|^CODEX_|^SSH_AUTH_SOCK$|^GH_CONFIG_DIR$|^DOCKER_CONFIG$|^npm_/);
    expect(process.env["GIT_CONFIG_NOSYSTEM"]).toBe("1");
  });

  it("has only its approved tools on PATH: no agent CLI, gh, security or browser opener", () => {
    if (process.platform === "win32") return;
    const folders = process.env["PATH"]!.split(delimiter).filter(one => !one.endsWith("codex-sandbox"));
    expect(folders).toHaveLength(1);
    for (const name of readdirSync(folders[0]!)) expect(APPROVED_TOOLS, name).toContain(name);
    for (const name of [...AGENT_CLIS, "gh", "security", "open", "xdg-open", "osascript"]) expect(existsSync(join(folders[0]!, name)), name).toBe(false);
    expect(execFileSync("sh", ["-lc", "command -v claude || echo none"], { encoding: "utf8" }).trim()).toBe("none");
  });

  it("puts Toolroll's git incidents, views and build caches in that home", () => {
    expect(inside(real(gitIncidentRecord()), real(homedir()))).toBe(true);
    expect(inside(buildCacheFolder(tmpdir()), homedir())).toBe(true);
    expect(inside(real(gitIncidentRecord()), person)).toBe(false);
  });

  it("gets folders outside the temp folder from the run's fake outer home, never the person's", () => {
    const made = outsideTempDir(".so-guard-");
    try {
      expect(inside(made, real(process.env["TOOLROLL_TEST_OUTER_HOME"]!)) || inside(made, real(homedir()))).toBe(true);
      expect(inside(made, real(tmpdir()))).toBe(false);
    } finally { rmSync(made, { recursive: true, force: true }); }
  });
});

describe("a test run's residue check", () => {
  const made: string[] = [];
  afterEach(() => { for (const one of made.splice(0)) { try { chmodSync(one, 0o755); } catch { /* gone */ } rmSync(one, { recursive: true, force: true }); } });

  const run = () => {
    const fake = realpathSync(mkdtempSync(join(tmpdir(), "so-person-")));
    const outerParent = realpathSync(mkdtempSync(join(tmpdir(), "so-outer-")));
    made.push(fake, outerParent);
    const before = { TMPDIR: process.env["TMPDIR"], OUTER: process.env["TOOLROLL_TEST_OUTER_HOME"] };
    const teardown = tempRoot(undefined, { homes: [fake], outerParent });
    const root = process.env["TMPDIR"]!, outer = process.env["TOOLROLL_TEST_OUTER_HOME"]!;
    process.env["TMPDIR"] = before.TMPDIR; process.env["TOOLROLL_TEST_OUTER_HOME"] = before.OUTER;
    return { fake, root, outer, teardown };
  };

  it("fails, naming what was left, when a test wrote into the person's home", () => {
    const { fake, root, outer, teardown } = run();
    mkdirSync(join(fake, ".toolroll"), { recursive: true });
    appendFileSync(join(fake, ".toolroll", "git-incidents.jsonl"), `${JSON.stringify({ checkout: join(root, "so-flex-thread-x", "projects", "shop") })}\n`);
    mkdirSync(join(fake, ".claude", "projects", `${real(outer).replace(/[^a-zA-Z0-9]/g, "-")}-so-attack-a`), { recursive: true });
    expect(() => teardown()).toThrow(/Residue check: these tests left 2 trace\(s\).*git-incidents\.jsonl:1/s);
  });

  it("fails as unknown when it can't read a place it watches", () => {
    const { fake, teardown } = run();
    const projects = join(fake, ".claude", "projects");
    mkdirSync(projects, { recursive: true });
    chmodSync(projects, 0o000);
    made.push(projects);
    try { expect(() => teardown()).toThrow(/couldn't read .*projects.*unknown, not clean/); } finally { chmodSync(projects, 0o755); }
  });

  it("passes when the person's home only changed in ways that aren't this run's", () => {
    const { fake, teardown } = run();
    mkdirSync(join(fake, ".toolroll"), { recursive: true });
    writeFileSync(join(fake, ".toolroll", "git-incidents.jsonl"), `${JSON.stringify({ checkout: "/elsewhere/so-t123456/shop" })}\n`);
    mkdirSync(join(fake, ".claude", "projects", "-Users-someone-Developer-app"), { recursive: true });
    expect(() => teardown()).not.toThrow();
  });
});
