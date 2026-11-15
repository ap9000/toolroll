import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
// @ts-expect-error plain ESM script without declarations
import { AGENT_CLIS, assertIsolated, claudeSlug, isolatedEnvironment, onPath, openedLines, passes, realHomeGuard } from "../scripts/isolated-env.mjs";

// The journeys' throwaway computer (scripts/isolated-env.mjs). 2026-11-14: a journey spread `{ ...process.env }` after
// its throwaway HOME and PATH; the console it started ran the person's own Claude Code under their own home. These hold
// the builder to an environment made from nothing, and the guard to catching exactly that spread.

const inside = (child: string, parent: string): boolean => child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
let dir: string, person: string, agents: string, tools: string, outer: Record<string, string>;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "so-isolated-env-")));
  person = join(dir, "person"); agents = join(person, ".local", "bin"); tools = join(dir, "usr-local-bin");
  for (const one of [agents, tools, join(person, ".claude", "projects")]) mkdirSync(one, { recursive: true });
  // The person's PATH: their own agent CLIs and opener beside ordinary tools in the same folder.
  for (const [folder, name] of [[agents, "claude"], [tools, "codex"], [tools, "gemini"], [tools, "opencode"], [tools, "open"], [tools, "xdg-open"], [tools, "gh"], [tools, "docker"]] as const) {
    writeFileSync(join(folder, name), "#!/bin/sh\necho REAL\n"); chmodSync(join(folder, name), 0o755);
  }
  outer = { HOME: person, PATH: `${agents}:${tools}:/usr/bin:/bin`, USER: "alex", LANG: "en_US.UTF-8", ANTHROPIC_API_KEY: "sk-ant-x", OPENAI_API_KEY: "sk-x",
    CLAUDE_CONFIG_DIR: join(person, ".claude"), CODEX_HOME: join(person, ".codex"), GH_TOKEN: "gho_x", SECRET_THING: "x", TOOLROLL_DB: join(person, "orders.db"),
    TOOLROLL_CHECK_GATE: "/gate", TOOLROLL_RELEASE_FAIL_FAST: "1", TOOLROLL_SOME_TOKEN: "x", https_proxy: "http://127.0.0.1:9", CI: "true" };
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("isolatedEnvironment", () => {
  it("builds the environment from nothing: the world's HOME, XDG folders and temp, and only allowlisted names", () => {
    const world = isolatedEnvironment({ root: join(dir, "world"), outer });
    const env = world.env as Record<string, string>;
    for (const name of ["HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "TMPDIR"]) expect(inside(env[name]!, world.root), name).toBe(true);
    for (const name of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "GH_TOKEN", "SECRET_THING", "TOOLROLL_DB", "TOOLROLL_SOME_TOKEN"]) expect(env[name], name).toBeUndefined();
    for (const name of ["LANG", "TOOLROLL_CHECK_GATE", "TOOLROLL_RELEASE_FAIL_FAST", "https_proxy", "CI"]) expect(env[name], name).toBe(outer[name]);
    expect(env["TOOLROLL_SECRET_STORE"]).toBe("files");
    expect(passes("PATH")).toBe(false);
    expect(passes("HOME")).toBe(false);
  });

  it("finds no agent CLI on its PATH but the world's stand-ins, while keeping the other tools in the same folders", () => {
    const stands = join(dir, "stands");
    mkdirSync(stands);
    writeFileSync(join(stands, "claude"), "#!/bin/sh\necho SCRIPTED\n"); chmodSync(join(stands, "claude"), 0o755);
    const world = isolatedEnvironment({ root: join(dir, "world"), outer, first: [stands] });
    const path = (world.env as Record<string, string>)["PATH"]!;
    expect(onPath("claude", path)).toBe(join(stands, "claude"));
    for (const agent of AGENT_CLIS.filter((one: string) => one !== "claude")) expect(onPath(agent, path), agent).toBeNull();
    expect(onPath("gh", path)).not.toBeNull();
    expect(onPath("docker", path)).not.toBeNull();
    expect(onPath("node", path)).not.toBeNull();
    expect(assertIsolated(world.env, { root: world.root, allowed: [stands] })).toBe(true);
    // As a shell inside the world sees it.
    const seen = execFileSync("/bin/sh", ["-c", "for a in claude codex gemini opencode; do command -v $a || echo \"$a none\"; done"], { env: world.env, encoding: "utf8" }).trim().split("\n");
    expect(seen).toEqual([join(stands, "claude"), "codex none", "gemini none", "opencode none"]);
  });

  it("hands every page a browser opener gets to a recording stand-in that opens nothing", () => {
    const world = isolatedEnvironment({ root: join(dir, "world"), outer });
    const env = world.env as Record<string, string>;
    for (const opener of ["open", "xdg-open"]) {
      expect(inside(onPath(opener, env["PATH"])!, world.root)).toBe(true);
      execFileSync(opener, ["/tmp/page.html"], { env });
    }
    execFileSync(env["BROWSER"]!, ["http://127.0.0.1:4850/"], { env });
    expect(env["TOOLROLL_BROWSER_COMMAND"]).toBe(env["BROWSER"]);
    expect(openedLines(world.opened)).toEqual(["open /tmp/page.html", "xdg-open /tmp/page.html", "browser http://127.0.0.1:4850/"]);
    expect(readFileSync(join(tools, "open"), "utf8")).toContain("REAL");
  });
});

describe("assertIsolated", () => {
  it("fails the 2026-11-14 shape: a copy of the caller's environment spread after the world's HOME and PATH", () => {
    const world = isolatedEnvironment({ root: join(dir, "world"), outer });
    const spread = { ...world.env, ...outer };
    expect(() => assertIsolated(spread, { root: world.root, allowed: [] })).toThrow(/HOME is .*outside.*claude resolves to .*\.local\/bin\/claude, not a stand-in/s);
  });

  it("fails when only the PATH comes back", () => {
    const world = isolatedEnvironment({ root: join(dir, "world"), outer });
    expect(() => assertIsolated({ ...world.env, PATH: outer["PATH"] }, { root: world.root, platform: "darwin" })).toThrow(/claude resolves to .*codex resolves to .*open resolves to/s);
  });

  it("fails on a credential folder pointed outside the world", () => {
    const world = isolatedEnvironment({ root: join(dir, "world"), outer });
    expect(() => assertIsolated({ ...world.env, CLAUDE_CONFIG_DIR: join(person, ".claude") }, { root: world.root })).toThrow(/CLAUDE_CONFIG_DIR points outside/);
  });
});

describe("realHomeGuard", () => {
  it("names what a leaked build left in the person's home: a transcript folder after the world's paths, the repository's build cache", () => {
    const root = join(dir, "world"), repo = join(root, "shop");
    mkdirSync(repo, { recursive: true });
    const incidents = join(person, ".toolroll", "git-incidents.jsonl");
    mkdirSync(join(person, ".toolroll"));
    writeFileSync(incidents, `${JSON.stringify({ checkout: "/elsewhere/worktrees/a" })}\n`);
    // Someone else's session appears meanwhile: not this run's.
    const guard = realHomeGuard({ root, repos: [repo], homes: [person], platform: "darwin" });
    expect(guard.check()).toEqual([]);
    mkdirSync(join(person, ".claude", "projects", "-Users-alex-Developer-other"));
    expect(guard.check()).toEqual([]);
    const transcripts = join(person, ".claude", "projects", `${claudeSlug(realpathSync(root))}-worktrees-shop-toolroll-task-1`);
    mkdirSync(transcripts);
    const cache = join(person, "Library", "Caches", "toolroll-builds", createHash("sha256").update(realpathSync(repo)).digest("hex").slice(0, 16));
    mkdirSync(cache, { recursive: true });
    writeFileSync(incidents, `${JSON.stringify({ checkout: "/elsewhere/worktrees/a" })}\n${JSON.stringify({ checkout: join(realpathSync(root), "worktrees", "b") })}\n`);
    expect(guard.check()).toEqual([cache, transcripts, `${incidents}:2`].sort());
    expect(existsSync(transcripts)).toBe(true);
  });

  it("never watches a home inside the world itself", () => {
    const root = join(dir, "world");
    mkdirSync(join(root, "home"), { recursive: true });
    expect(realHomeGuard({ root, homes: [join(root, "home"), person] }).homes).toEqual([person]);
  });
});
