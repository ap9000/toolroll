/**
 * Attack: write outside the workspace (docs/plans/agent-baseline-hardening.md, arc 2): rewrite the operator's shell
 * profile, plant a LaunchAgent, change Claude's settings for the next interactive session, change the repository's
 * shared Git config, hooks or attributes (which Git runs as commands), read another live Claude session's keys, or
 * leave something in the shared temp folder.
 * Guard: a `workspace` build writes only its allowlist (its checkout and Git data less config/hooks/info, its launch
 * folder, its project's cache folder, the provider state its CLI must write); the macOS sandbox, bubblewrap and
 * Codex's profile each enforce it.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { claudeProjectFolder, linuxFenced, NO_GRANTS, writeAllowlist, type FenceGrants } from "../../src/agent-fence.js";
import { codexSandbox, git, GIT_ENV, lines, needs, repository, seatbelt, underCodex, underSeatbelt, useScratch } from "./harness.js";

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

  test("a workspace build writes its checkout, commits, its temp, its caches and its transcript, and nothing of the operator's", ctx => {
    needs(ctx, seatbelt());
    const dir = scratch();
    const w = world(dir, "claude");
    const shared = join("/private/tmp", `so-writes-probe-${process.pid}`);
    const result = underSeatbelt([script(w, shared), `touch ${w.transcript}/session.jsonl && echo transcript-ok`].join("\n"), w.fence, w.grants, { cwd: w.worktree, env: { ...process.env, ...GIT_ENV } });
    expect(lines(result), result.stderr).toEqual([...REFUSED, "sessions-refused", "shared-temp-refused", ...ALLOWED, "transcript-ok"]);
    untouched(w);
    expect(git(w.worktree, "log", "-1", "--format=%s")).toBe("feature");
  });

  test("Gemini writes its history, temp and project list (and its atomic-rename names), never its settings", ctx => {
    needs(ctx, seatbelt());
    const w = world(scratch(), "gemini");
    writeFileSync(join(w.home, ".gemini", "settings.json"), "{}\n");
    const result = underSeatbelt([
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

/** Whether bubblewrap runs a read-only root here. */
function bubblewrap(): { available: boolean; note: string } {
  if (process.platform !== "linux") return { available: false, note: "bubblewrap write checks skipped: not Linux" };
  const ran = spawnSync("bwrap", ["--ro-bind", "/", "/", "--dev", "/dev", "--", "true"], { encoding: "utf8", timeout: 5_000 });
  return ran.status === 0 ? { available: true, note: "" } : { available: false, note: `bubblewrap write checks skipped: ${(ran.stderr ?? "").trim()}` };
}

function underBubblewrap(text: string, fence: readonly string[], grants: FenceGrants, cwd: string): Promise<{ stdout: string; stderr: string }> {
  const { file, args } = linuxFenced("/bin/sh", ["-c", text], fence, grants);
  return new Promise(done => {
    const child = spawn(file, args, { cwd, env: { ...process.env, ...GIT_ENV, NODE_OPTIONS: undefined } });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += String(chunk); });
    child.stderr.on("data", chunk => { stderr += String(chunk); });
    child.on("close", () => done({ stdout, stderr }));
  });
}

describe("attack: writing outside the workspace (Linux)", () => {
  const scratch = useScratch("writes-linux");

  test("a read-only root with the allowlist bound back; its /tmp is its own", async ctx => {
    needs(ctx, bubblewrap());
    const w = world(scratch(), "claude");
    const result = await underBubblewrap([script(w, "/tmp/so-writes-probe"), "test -e /tmp/so-writes-probe && echo private-tmp-ok"].join("\n"), w.fence, w.grants, w.worktree);
    // The build's /tmp is its own: what it leaves there is gone with it, so the shared one is never written.
    expect(lines(result), result.stderr).toEqual([...REFUSED, "sessions-refused", ...ALLOWED, "private-tmp-ok"]);
    untouched(w);
    expect(spawnSync("test", ["-e", "/tmp/so-writes-probe"]).status).not.toBe(0);
  });
});
