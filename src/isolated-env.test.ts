import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
// @ts-expect-error plain ESM script without declarations
import { AGENT_CLIS, APPROVED_TOOLS, assertIsolated, claudeSlug, isolatedEnvironment, onPath, openedLines, passes, residueCheck, validOverrides } from "../scripts/isolated-env.mjs";

// The journeys' throwaway computer (scripts/isolated-env.mjs). 2026-11-14: a journey spread `{ ...process.env }` after
// its throwaway HOME and PATH; the console it started ran the person's own Claude Code under their own home. PATH is an
// allowlist of run-owned folders; the check resolves every program on it.

const inside = (child: string, parent: string): boolean => child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
let dir: string, person: string, agents: string, tools: string, outer: Record<string, string>;
type Env = Record<string, string>;
const exe = (path: string, text = "#!/bin/sh\necho REAL\n") => { writeFileSync(path, text); chmodSync(path, 0o755); };

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "so-isolated-env-")));
  person = join(dir, "person"); agents = join(person, ".local", "bin"); tools = join(dir, "usr-local-bin");
  for (const one of [agents, tools, join(person, ".claude", "projects")]) mkdirSync(one, { recursive: true });
  // The person's PATH: their agent CLIs and opener beside ordinary tools, and the approved ones (git, sh) from the test's own.
  for (const [folder, name] of [[agents, "claude"], [tools, "codex"], [tools, "gemini"], [tools, "copilot"], [tools, "droid"], [tools, "open"], [tools, "xdg-open"], [tools, "gh"], [tools, "security"], [tools, "docker"]] as const) exe(join(folder, name));
  outer = { HOME: person, PATH: `${agents}:${tools}:${process.env["PATH"]}`, USER: "alex", LANG: "en_US.UTF-8", ANTHROPIC_API_KEY: "sk-ant-x", OPENAI_API_KEY: "sk-x",
    CLAUDE_CONFIG_DIR: join(person, ".claude"), CODEX_HOME: join(person, ".codex"), GH_TOKEN: "gho_x", GH_CONFIG_DIR: join(person, ".config", "gh"), DOCKER_CONFIG: join(person, ".docker"),
    SSH_AUTH_SOCK: "/tmp/agent.sock", AWS_SECRET_ACCESS_KEY: "x", SECRET_THING: "x", TOOLROLL_DB: join(person, "orders.db"), XAUTHORITY: join(person, ".Xauthority"),
    TOOLROLL_CHECK_GATE: "/gate", TOOLROLL_RELEASE_FAIL_FAST: "1", TOOLROLL_SOME_TOKEN: "x", GITHUB_TOKEN: "x", RUNNER_TEMP: "/r",
    https_proxy: "http://127.0.0.1:9", HTTP_PROXY: "http://user:pass@proxy.example:3128", CI: "true" };
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("isolatedEnvironment", () => {
  it("builds the environment from nothing: the world's HOME, XDG folders and temp, and only exactly named, credential-free names", () => {
    const world = isolatedEnvironment({ root: join(dir, "world"), outer });
    const env = world.env as Env;
    for (const name of ["HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "TMPDIR", "ZDOTDIR", "GIT_CONFIG_GLOBAL"]) expect(inside(env[name]!, world.root), name).toBe(true);
    for (const name of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "GH_TOKEN", "GH_CONFIG_DIR", "DOCKER_CONFIG", "SSH_AUTH_SOCK",
      "AWS_SECRET_ACCESS_KEY", "SECRET_THING", "TOOLROLL_DB", "TOOLROLL_SOME_TOKEN", "GITHUB_TOKEN", "RUNNER_TEMP", "XAUTHORITY", "HTTP_PROXY"]) expect(env[name], name).toBeUndefined();
    for (const name of ["LANG", "TOOLROLL_CHECK_GATE", "TOOLROLL_RELEASE_FAIL_FAST", "https_proxy", "CI"]) expect(env[name], name).toBe(outer[name]);
    expect(passes("HTTPS_PROXY", "http://u:p@x:1")).toBe(false);
    expect(passes("HTTPS_PROXY", "http://x:1")).toBe(true);
    expect(passes("PATH", "/usr/bin")).toBe(false);
  });

  it("puts only run-owned folders on PATH: the stand-ins, and approved tools by exact name, each by its resolved path", () => {
    const world = isolatedEnvironment({ root: join(dir, "world"), outer });
    const env = world.env as Env;
    for (const one of env["PATH"]!.split(":")) expect(inside(realpathSync(one), world.root), one).toBe(true);
    for (const name of readdirSync(world.tools).filter(one => one !== ".approved.json")) expect(APPROVED_TOOLS, name).toContain(name);
    for (const agent of AGENT_CLIS) expect(onPath(agent, env["PATH"]), agent).toBeNull();
    for (const absent of ["security", "docker", "osascript"]) expect(onPath(absent, env["PATH"]), absent).toBeNull();
    expect(realpathSync(onPath("node", env["PATH"]))).toBe(realpathSync(process.execPath));
    expect(inside(onPath("gh", env["PATH"]), world.root)).toBe(true);
    expect(assertIsolated(env, { root: world.root })).toBe(true);
    // Docker only where a journey asks for it.
    expect(onPath("docker", isolatedEnvironment({ root: join(dir, "mail"), outer, tools: ["docker"] }).env["PATH"])).not.toBeNull();
  });

  it("never lets a login shell rebuild PATH: zsh -lc, bash -lc and sh -lc find only the stand-in, or nothing", () => {
    const stands = join(dir, "world", "stands");
    mkdirSync(stands, { recursive: true });
    exe(join(stands, "claude"), "#!/bin/sh\necho SCRIPTED\n");
    const world = isolatedEnvironment({ root: join(dir, "world"), outer, first: [stands] });
    for (const shell of ["zsh", "bash", "sh"].filter(one => onPath(one, world.env["PATH"]) !== null)) {
      const seen = execFileSync(shell, ["-lc", "command -v claude || echo none; command -v codex || echo none; echo \"$PATH\""], { env: world.env, encoding: "utf8" }).trim().split("\n");
      expect(seen, shell).toEqual([join(stands, "claude"), "none", world.env["PATH"]]);
    }
    const bare = isolatedEnvironment({ root: join(dir, "bare"), outer });
    for (const shell of ["zsh", "bash"].filter(one => onPath(one, bare.env["PATH"]) !== null)) {
      expect(execFileSync(shell, ["-l", "-c", "command -v claude || echo none"], { env: bare.env, encoding: "utf8" }).trim(), shell).toBe("none");
    }
  });

  it("shell wrappers drop the login flag from a flag cluster and keep the rest, without starting any process of their own", () => {
    const world = isolatedEnvironment({ root: join(dir, "world"), outer });
    if (onPath("bash", world.env["PATH"]) === null) return;
    const ran = spawnSync("bash", ["-lxc", "shopt -q login_shell && echo login || echo plain"], { env: world.env, encoding: "utf8" });
    expect(ran.stdout.trim()).toBe("plain");
    expect(ran.stderr).toContain("+ shopt -q login_shell");
    // Pure shell before its exec: no command substitution, pipe or external tool that would fork a child first.
    for (const shell of ["sh", "bash", "zsh"].filter(one => existsSync(join(world.tools, one)))) {
      const text = readFileSync(join(world.tools, shell), "utf8");
      expect(text, shell).not.toMatch(/\$\((?!\()|`|\|\s*tr\b|\btr -d/);
    }
  });

  it("hands every page a browser opener gets to a recording stand-in, and answers gh from a script", () => {
    const world = isolatedEnvironment({ root: join(dir, "world"), outer });
    const env = world.env as Env;
    for (const opener of ["open", "xdg-open"]) execFileSync(opener, ["/tmp/page.html"], { env });
    execFileSync(env["BROWSER"]!, ["http://127.0.0.1:4850/"], { env });
    expect(openedLines(world.opened)).toEqual(["open /tmp/page.html", "xdg-open /tmp/page.html", "browser http://127.0.0.1:4850/"]);
    expect(JSON.parse(execFileSync("gh", ["api", "-H", "Accept: application/vnd.github+json", "repos/a/b/actions/runs?branch=main&status=failure&per_page=20"], { env, encoding: "utf8" }))).toEqual({ total_count: 0, workflow_runs: [] });
    expect(readFileSync(world.ghCalls, "utf8")).toContain("repos/a/b/actions/runs");
  });

  it("refuses overrides that point HOME, PATH or an XDG folder outside the world", () => {
    const root = join(dir, "world");
    expect(() => isolatedEnvironment({ root, outer, set: { HOME: person } })).toThrow(/HOME=.* outside the world/);
    expect(() => isolatedEnvironment({ root, outer, set: { PATH: agents } })).toThrow(/PATH entry .* is not a folder of the world/);
    expect(() => isolatedEnvironment({ root, outer, set: { XDG_CONFIG_HOME: join(person, ".config") } })).toThrow(/XDG_CONFIG_HOME=.* outside/);
    expect(() => isolatedEnvironment({ root, outer, first: [agents] })).toThrow(/not inside the world/);
    expect(() => validOverrides({ TMPDIR: "/elsewhere" }, { root })).toThrow(/TMPDIR/);
  });
});

describe("assertIsolated", () => {
  const world = () => isolatedEnvironment({ root: join(dir, "world"), outer });

  it("fails the 2026-11-14 shape: a copy of the caller's environment spread after the world's", () => {
    const made = world();
    expect(() => assertIsolated({ ...made.env, ...outer }, { root: made.root })).toThrow(/HOME is .*outside.*PATH entry .* is not a folder of the world/s);
  });

  it("refuses empty and relative PATH entries", () => {
    const made = world();
    expect(() => assertIsolated({ ...made.env, PATH: `${made.env["PATH"]}:` }, { root: made.root })).toThrow(/an empty entry/);
    expect(() => assertIsolated({ ...made.env, PATH: `bin:${made.env["PATH"]}` }, { root: made.root })).toThrow(/a relative entry/);
  });

  it("follows links: a stand-in folder holding a link to a real agent CLI fails, wherever on PATH it is", () => {
    const made = world();
    const sneaky = join(made.root, "sneaky");
    mkdirSync(sneaky);
    symlinkSync(join(agents, "claude"), join(sneaky, "claude"));
    // Not the first match: the world's own bin comes first, the link later.
    expect(() => assertIsolated({ ...made.env, PATH: `${made.env["PATH"]}:${sneaky}` }, { root: made.root })).toThrow(/claude on PATH .* resolves to .*\.local\/bin\/claude, not a stand-in/);
  });

  it("refuses an unlisted program in the tools folder, and a program from outside the world anywhere else", () => {
    const made = world();
    symlinkSync(join(tools, "docker"), join(made.tools, "kubectl"));
    expect(() => assertIsolated(made.env, { root: made.root })).toThrow(/kubectl isn't an approved tool/);
    rmSync(join(made.tools, "kubectl"));
    symlinkSync(join(tools, "docker"), join(made.bin, "dockerish"));
    expect(() => assertIsolated(made.env, { root: made.root })).toThrow(/dockerish resolves to .*outside the world/);
  });

  it("checks approved tools by their recorded target: a swapped link or an edited shell wrapper fails", () => {
    const made = world();
    rmSync(join(made.tools, "git"));
    symlinkSync(join(tools, "docker"), join(made.tools, "git"));
    expect(() => assertIsolated(made.env, { root: made.root })).toThrow(/tools\/git no longer resolves to the approved/);
    const again = isolatedEnvironment({ root: join(dir, "again"), outer });
    writeFileSync(join(again.tools, "sh"), "#!/bin/sh\nexec /bin/sh -l \"$@\"\n");
    expect(() => assertIsolated(again.env, { root: again.root })).toThrow(/tools\/sh no longer resolves to the approved/);
  });

  it("fails on a PATH folder it can't read", () => {
    const made = world();
    const locked = join(made.root, "locked");
    mkdirSync(locked);
    chmodSync(locked, 0o000);
    try { expect(() => assertIsolated({ ...made.env, PATH: `${made.env["PATH"]}:${locked}` }, { root: made.root })).toThrow(/locked can't be read/); }
    finally { chmodSync(locked, 0o755); }
  });

  it("refuses credential-shaped names and startup hooks, whatever brought them; with `names`, any name not listed", () => {
    const made = world();
    for (const [name, value] of [["GH_TOKEN", "x"], ["MY_API_KEY", "x"], ["DB_PASSWORD", "x"], ["AWS_PROFILE", "x"], ["ANTHROPIC_BASE_URL", "x"], ["GITHUB_TOKEN", "x"],
      ["BASH_ENV", "/x"], ["ENV", "/x"], ["NODE_OPTIONS", "--require /x.js"], ["PYTHONSTARTUP", "/x.py"], ["PERL5OPT", "-Mx"], ["LD_PRELOAD", "/x.so"], ["DYLD_INSERT_LIBRARIES", "/x.dylib"]]) {
      expect(() => assertIsolated({ ...made.env, [name]: value }, { root: made.root }), name).toThrow(new RegExp(name));
    }
    expect(assertIsolated({ ...made.env, NODE_OPTIONS: "" }, { root: made.root })).toBe(true);
    expect(() => assertIsolated({ ...made.env, SOMETHING_ELSE: "1" }, { root: made.root, names: Object.keys(made.env) })).toThrow(/SOMETHING_ELSE isn't a name this child may get/);
  });

  it("starts shells without BASH_ENV or ENV, so neither can run first", () => {
    const made = world();
    const hook = join(made.root, "hook.sh");
    writeFileSync(hook, "echo HOOK\n");
    for (const shell of ["bash", "sh"].filter(one => onPath(one, made.env["PATH"]) !== null)) {
      expect(execFileSync(shell, ["-c", "echo ran"], { env: { ...made.env, BASH_ENV: hook, ENV: hook }, encoding: "utf8" }).trim(), shell).toBe("ran");
    }
  });

  it("refuses credential folders and an SSH agent pointed outside the world", () => {
    const made = world();
    expect(() => assertIsolated({ ...made.env, GH_CONFIG_DIR: join(person, ".config", "gh") }, { root: made.root })).toThrow(/GH_CONFIG_DIR/);
    expect(() => assertIsolated({ ...made.env, DOCKER_CONFIG: join(person, ".docker") }, { root: made.root })).toThrow(/DOCKER_CONFIG/);
    expect(() => assertIsolated({ ...made.env, SSH_AUTH_SOCK: "/tmp/agent.sock" }, { root: made.root })).toThrow(/SSH_AUTH_SOCK/);
  });
});

describe("residueCheck (limited)", () => {
  const setup = () => {
    const root = join(dir, "world"), repo = join(root, "shop");
    mkdirSync(repo, { recursive: true });
    mkdirSync(join(person, ".toolroll"));
    const incidents = join(person, ".toolroll", "git-incidents.jsonl");
    writeFileSync(incidents, `${JSON.stringify({ checkout: "/elsewhere/worktrees/a" })}\n`);
    const transcripts = join(person, ".claude", "projects", `${claudeSlug(realpathSync(root))}-worktrees-shop-task-1`);
    const cache = join(person, "Library", "Caches", "toolroll-builds", createHash("sha256").update(realpathSync(repo)).digest("hex").slice(0, 16));
    return { root, repo, incidents, transcripts, cache };
  };

  it("names new transcript folders, the repository's build cache and incident lines naming the world; ignores other sessions", () => {
    const { root, repo, incidents, transcripts, cache } = setup();
    const check = residueCheck({ root, repos: [repo], homes: [person], platform: "darwin" });
    mkdirSync(join(person, ".claude", "projects", "-Users-alex-Developer-other"));
    expect(check.check().left).toEqual([]);
    mkdirSync(transcripts);
    mkdirSync(cache, { recursive: true });
    writeFileSync(incidents, `${readFileSync(incidents, "utf8")}${JSON.stringify({ checkout: join(realpathSync(root), "worktrees", "b") })}\n`);
    expect(check.check().left).toEqual([cache, transcripts, `${incidents}:2`].sort());
  });

  it("sees a change inside a transcript or cache folder that was already there", () => {
    const { root, repo, transcripts, cache } = setup();
    mkdirSync(transcripts); mkdirSync(cache, { recursive: true });
    writeFileSync(join(transcripts, "old.jsonl"), "{}\n");
    const check = residueCheck({ root, repos: [repo], homes: [person], platform: "darwin" });
    writeFileSync(join(transcripts, "new.jsonl"), "{}\n");
    writeFileSync(join(cache, "npm"), "x");
    expect(check.check().left).toEqual([cache, transcripts].sort());
    const again = residueCheck({ root, repos: [repo], homes: [person], platform: "darwin" });
    utimesSync(join(transcripts, "old.jsonl"), new Date(0), new Date(0));
    expect(again.check().left).toEqual([transcripts]);
  });

  it("says a place it can't read is unknown and fails on it, inside a watched folder too, unless the caller accepts that up front", () => {
    const { root, transcripts } = setup();
    const projects = join(person, ".claude", "projects");
    chmodSync(projects, 0o000);
    try {
      const result = residueCheck({ root, homes: [person], platform: "darwin" }).check();
      expect(result.unknown.join(" ")).toContain(projects);
      expect(result.unknownFails).toBe(true);
      expect(residueCheck({ root, homes: [person], platform: "darwin", acceptUnreadable: true }).check()).toMatchObject({ unknownFails: false, acceptedUnreadable: true });
    } finally { chmodSync(projects, 0o755); }
    // A transcript folder of this run that can't be listed is unknown too, never "nothing there".
    mkdirSync(transcripts);
    chmodSync(transcripts, 0o000);
    try {
      const result = residueCheck({ root, homes: [person], platform: "darwin" }).check();
      expect(result.unknown.join(" ")).toContain(transcripts);
      expect(result.unknownFails).toBe(true);
    } finally { chmodSync(transcripts, 0o755); }
  });

  it("says what it covers: build caches only with a repository", () => {
    const { root, repo } = setup();
    expect(residueCheck({ root, homes: [person] }).covers).toEqual({ transcripts: true, buildCaches: false, incidents: true });
    expect(residueCheck({ root, repos: [repo], homes: [person] }).covers.buildCaches).toBe(true);
    expect(existsSync(person)).toBe(true);
  });
});
