/**
 * Attack: write outside the workspace (docs/plans/agent-baseline-hardening.md, arc 2): rewrite the operator's shell
 * profile, plant a LaunchAgent, change Claude's settings for the next interactive session, change the repository's
 * shared Git config, hooks or attributes (which Git runs as commands), read another live Claude session's keys, or
 * leave something in the shared temp folder.
 * Guard: a `workspace` build writes only its allowlist (its checkout and Git data less config/hooks/info, its launch
 * folder, its project's cache folder, the provider state its CLI must write); Anthropic's sandbox-runtime (Seatbelt on
 * a Mac, bubblewrap on Linux) and Codex's profile each enforce it.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { claudeProjectFolder, NO_GRANTS, sandboxedSpawn, writeAllowlist, type FenceGrants } from "../../src/agent-fence.js";
import { codexSandbox, git, GIT_ENV, lines, needs, osFence, repository, seatbelt, underCodex, underSandbox, underSandboxAsync, useScratch } from "./harness.js";
import { outsideTempDir } from "../short-temp.js";

type World = { home: string; main: string; worktree: string; launch: string; cache: string; fence: string[]; grants: FenceGrants; transcript: string };

/** A home folder with the operator's own files, a repository and a task's worktree of it, and the build's folders. */
function world(dir: string, provider: string): World {
  const home = join(dir, "home");
  for (const folder of [join(home, "Library", "LaunchAgents"), join(home, ".claude", "sessions"), join(home, ".gemini")]) mkdirSync(folder, { recursive: true });
  writeFileSync(join(home, ".zshrc"), "# operator\n");
  writeFileSync(join(home, ".claude", "settings.json"), "{}\n");
  writeFileSync(join(home, ".claude", "sessions", "peer.json"), "peer-key\n");
  const main = repository(join(dir, "repo"));
  const worktree = join(dir, "worktrees", "task-1");
  mkdirSync(join(dir, "worktrees"), { recursive: true });
  git(main, "worktree", "add", "-q", "-b", "task-1", worktree);
  const launch = join(dir, "so-tools-run");
  mkdirSync(join(launch, "tmp"), { recursive: true });
  const cache = join(dir, "cache");
  const gitdir = realpathSync(join(main, ".git", "worktrees", "task-1"));
  const allowed = writeAllowlist({ provider, home, worktree, binding: { main: realpathSync(main), gitdir }, launchFolder: launch, cache });
  return {
    home: realpathSync(home), main: realpathSync(main), worktree: realpathSync(worktree), launch: realpathSync(launch), cache: realpathSync(cache),
    fence: allowed.deny.map(path => realpathSync(path)),
    grants: { ...NO_GRANTS, writes: allowed.writes, readOnly: allowed.readOnly },
    transcript: claudeProjectFolder(realpathSync(home), realpathSync(worktree)).path,
  };
}

/** Each attempt prints `<name>-refused` when the write fails; each allowed one prints `<name>-ok`. */
function script(w: World, shared: string): string {
  return [
    `echo evil >> ${w.home}/.zshrc 2>/dev/null || echo zshrc-refused`,
    `touch ${w.home}/Library/LaunchAgents/evil.plist 2>/dev/null || echo launchagent-refused`,
    `echo '{"hooks":1}' > ${w.home}/.claude/settings.json 2>/dev/null || echo claude-settings-refused`,
    `echo '[core]' >> ${w.main}/.git/config 2>/dev/null || echo git-config-refused`,
    `touch ${w.main}/.git/hooks/post-checkout 2>/dev/null || echo git-hooks-refused`,
    `echo '* filter=evil' > ${w.main}/.git/info/attributes 2>/dev/null || echo git-info-refused`,
    `mkdir -p ${w.main}/.git/modules/evil 2>/dev/null || echo git-modules-refused`,
    `echo /elsewhere > ${w.main}/.git/objects/info/alternates 2>/dev/null || echo git-alternates-refused`,
    `touch ${w.main}/.git/worktrees/other 2>/dev/null || echo git-worktrees-refused`,
    `cat ${w.home}/.claude/sessions/peer.json >/dev/null 2>&1 || echo sessions-refused`,
    `touch ${shared} 2>/dev/null || echo shared-temp-refused`,
    `echo work > ${w.worktree}/feature.txt && echo worktree-ok`,
    `git -C ${w.worktree} add feature.txt && git -C ${w.worktree} commit -q -m feature && echo commit-ok`,
    `touch ${w.launch}/tmp/scratch && echo temp-ok`,
    `mkdir -p ${w.cache}/npm && touch ${w.cache}/npm/index && echo cache-ok`,
    `echo '{}' > /dev/null && echo devnull-ok`,
  ].join("\n");
}

const REFUSED = ["zshrc-refused", "launchagent-refused", "claude-settings-refused", "git-config-refused", "git-hooks-refused", "git-info-refused",
  "git-modules-refused", "git-alternates-refused", "git-worktrees-refused"];
const ALLOWED = ["worktree-ok", "commit-ok", "temp-ok", "cache-ok", "devnull-ok"];

/** The operator's files are exactly as they were. */
function untouched(w: World): void {
  expect(readFileSync(join(w.home, ".zshrc"), "utf8")).toBe("# operator\n");
  expect(readFileSync(join(w.home, ".claude", "settings.json"), "utf8")).toBe("{}\n");
  expect(readFileSync(join(w.main, ".git", "config"), "utf8")).not.toContain("[core]\n[core]");
}

describe("attack: writing outside the workspace (macOS)", () => {
  const scratch = useScratch("writes");
  const cleanup: string[] = [];
  afterEach(() => { for (const one of cleanup.splice(0)) rmSync(one, { recursive: true, force: true }); });

  test("a workspace build writes its checkout, commits, its temp, its caches and its transcript, and nothing of the operator's", ctx => {
    needs(ctx, seatbelt());
    const dir = scratch();
    const w = world(dir, "claude");
    const shared = join("/private/tmp", `so-writes-probe-${process.pid}`);
    const result = underSandbox([script(w, shared), `touch ${w.transcript}/session.jsonl && echo transcript-ok`].join("\n"), w.fence, w.grants, { cwd: w.worktree, env: { ...process.env, ...GIT_ENV } });
    expect(lines(result), result.stderr).toEqual([...REFUSED, "sessions-refused", "shared-temp-refused", ...ALLOWED, "transcript-ok"]);
    untouched(w);
    expect(git(w.worktree, "log", "-1", "--format=%s")).toBe("feature");
  });

  test("a granted folder a build swapped for a link is never granted again, and a granted folder can't be swapped", ctx => {
    needs(ctx, seatbelt());
    const dir = scratch();
    const w = world(dir, "claude");
    // Inside the sandbox the cache folder can be removed (the runtime writes a granted folder whole, itself included);
    // swapped for a link, the next launch grants nothing there.
    const agents = join(w.home, "Library", "LaunchAgents");
    rmSync(w.cache, { recursive: true, force: true });
    symlinkSync(agents, w.cache);
    const next = writeAllowlist({ provider: "claude", home: w.home, worktree: w.worktree, binding: { main: w.main, gitdir: realpathSync(join(w.main, ".git", "worktrees", "task-1")) }, launchFolder: w.launch, cache: w.cache });
    expect(next.writes.subpaths).not.toContain(realpathSync(agents));
    const result = underSandbox(`touch ${w.cache}/evil.plist 2>/dev/null || echo planted-refused`, next.deny, { ...NO_GRANTS, writes: next.writes, readOnly: next.readOnly }, { cwd: w.worktree });
    expect(lines(result), result.stderr).toEqual(["planted-refused"]);
  });

  test("a build under a confined network reaches no unix socket outside its own folders", async ctx => {
    needs(ctx, seatbelt());
    // A unix socket's path is capped near 104 bytes: this world lives in a short folder of its own.
    const short = realpathSync(mkdtempSync("/tmp/sw-"));
    cleanup.push(short);
    const w = world(short, "claude");
    const socket = join(w.home, "engine.sock");
    const server = createNetServer(connection => connection.end("engine\n"));
    await new Promise<void>((done, fail) => { server.once("error", fail); server.listen(socket, done); });
    try {
      const own = join(w.launch, "tmp", "own.sock");
      const mine = createNetServer(connection => connection.end("mine\n"));
      await new Promise<void>((done, fail) => { mine.once("error", fail); mine.listen(own, done); });
      const run = (path: string) => `python3 -c "import socket; s=socket.socket(socket.AF_UNIX); s.connect('${path}'); print(s.recv(10).decode().strip())" 2>/dev/null || echo refused`;
      const result = await new Promise<{ stdout: string; stderr: string }>(done => {
        const { file, args, env } = sandboxedSpawn("/bin/sh", ["-c", [run(socket), run(own)].join("\n")], w.fence, { ...w.grants, network: { mode: "allowlist", proxyPort: 1, brokerPorts: [], loopback: "proxy-only", socketRoots: [join(w.launch, "tmp")] } }, w.worktree);
        const child = spawn(file, args, { cwd: w.worktree, env: { ...process.env, ...env } });
        let stdout = "", stderr = "";
        child.stdout.on("data", chunk => { stdout += String(chunk); });
        child.stderr.on("data", chunk => { stderr += String(chunk); });
        child.on("close", () => done({ stdout, stderr }));
      });
      mine.close();
      expect(lines(result), result.stderr).toEqual(["refused", "mine"]);
    } finally { server.close(); }
  });

  test("an ACP agent writes its own data, never its configuration", ctx => {
    needs(ctx, seatbelt());
    const w = world(scratch(), "opencode");
    const config = join(w.home, ".config", "opencode");
    const result = underSandbox([
      `echo '{"mcp":{"evil":{"command":["sh"]}}}' > ${config}/opencode.json 2>/dev/null || echo config-refused`,
      `mkdir -p ${config}/plugins 2>/dev/null; touch ${config}/plugins/evil.js 2>/dev/null || echo plugin-refused`,
      `touch ${config}/tui.json 2>/dev/null || echo new-config-refused`,
      `touch ${w.home}/.local/share/opencode/session.db && echo data-ok`,
    ].join("\n"), w.fence, w.grants, { cwd: w.worktree });
    expect(lines(result), result.stderr).toEqual(["config-refused", "plugin-refused", "new-config-refused", "data-ok"]);
  });

  test("Gemini writes its history, temp and project list (and its atomic-rename names), never its settings", ctx => {
    needs(ctx, seatbelt());
    const w = world(scratch(), "gemini");
    writeFileSync(join(w.home, ".gemini", "settings.json"), "{}\n");
    const result = underSandbox([
      `echo '{"mcpServers":1}' > ${w.home}/.gemini/settings.json 2>/dev/null || echo gemini-settings-refused`,
      `touch ${w.home}/.gemini/history/h && echo history-ok`,
      `echo '{}' > ${w.home}/.gemini/projects.json.tmp-1 && mv ${w.home}/.gemini/projects.json.tmp-1 ${w.home}/.gemini/projects.json && echo projects-ok`,
    ].join("\n"), w.fence, w.grants, { cwd: w.worktree });
    expect(lines(result), result.stderr).toEqual(["gemini-settings-refused", "history-ok", "projects-ok"]);
  });

  test("Codex's own profile keeps a full-access build to the same allowlist", ctx => {
    needs(ctx, codexSandbox());
    const dir = scratch();
    const w = world(dir, "codex");
    const codexHome = join(dir, "codex-home");
    mkdirSync(codexHome, { recursive: true });
    const result = underCodex([
      `echo evil >> ${w.home}/.zshrc 2>/dev/null || echo zshrc-refused`,
      `echo '[core]' >> ${w.main}/.git/config 2>/dev/null || echo git-config-refused`,
      `echo work > ${w.worktree}/feature.txt && echo worktree-ok`,
      `git -C ${w.worktree} add feature.txt && git -C ${w.worktree} -c user.name=t -c user.email=t@t commit -q -m feature && echo commit-ok`,
      `mkdir -p ${w.cache}/pip && echo cache-ok`,
    ].join("\n"), w.fence, true, w.grants, { cwd: w.worktree, codexHome });
    expect(lines(result), result.stderr).toEqual(["zshrc-refused", "git-config-refused", "worktree-ok", "commit-ok", "cache-ok"]);
    untouched(w);
  });
});

function underBubblewrap(text: string, fence: readonly string[], grants: FenceGrants, cwd: string): Promise<{ stdout: string; stderr: string }> {
  return underSandboxAsync(text, fence, grants, { cwd, env: { ...process.env, ...GIT_ENV, NODE_OPTIONS: undefined } as NodeJS.ProcessEnv });
}

describe("attack: writing outside the workspace (Linux)", () => {
  // Outside /tmp, as homes and checkouts are: a build's /tmp is its own, so a world there would be out of its sight.
  let dir: string | null = null;
  beforeEach(() => { dir = outsideTempDir(".so-attack-writes-"); });
  afterEach(() => { if (dir !== null) rmSync(dir, { recursive: true, force: true }); dir = null; });
  const scratch = () => dir!;

  test("the allowlist alone is written; the shared /tmp is not", async ctx => {
    ctx.skip(process.platform !== "linux", "Linux write checks skipped: not Linux");
    needs(ctx, osFence());
    const w = world(scratch(), "claude");
    const result = await underBubblewrap(script(w, "/tmp/so-writes-probe"), w.fence, w.grants, w.worktree);
    expect(lines(result), result.stderr).toEqual([...REFUSED, "sessions-refused", "shared-temp-refused", ...ALLOWED]);
    untouched(w);
    expect(spawnSync("test", ["-e", "/tmp/so-writes-probe"]).status).not.toBe(0);
  });
});
