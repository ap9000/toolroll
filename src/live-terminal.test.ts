/**
 * Live terminals (docs/plans/live-terminal.md): a real pty in its own worktree, scrollback replay, strict frames,
 * the session cap, and a close that takes the whole process group.
 */
import { describe, test, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPtySpawn, parseTerminalFrame, Scrollback, TerminalHost, type PtySpawn, type TerminalControl } from "./live-terminal.js";

const ALEX = { name: "alex", generation: 1 };
let spawn: PtySpawn | null = null;
beforeAll(() => { spawn = loadPtySpawn(); });

describe("frames", () => {
  test("input and resize, exactly", () => {
    expect(parseTerminalFrame(JSON.stringify({ t: "in", d: "ls\r" }))).toEqual({ t: "in", d: "ls\r" });
    expect(parseTerminalFrame(JSON.stringify({ t: "resize", cols: 80, rows: 24 }))).toEqual({ t: "resize", cols: 80, rows: 24 });
  });
  test("anything else is refused", () => {
    for (const bad of ["", "nope", "[]", "null", '{"t":"in"}', '{"t":"in","d":1}', '{"t":"in","d":"x","x":1}', '{"t":"resize","cols":1,"rows":24}',
      '{"t":"resize","cols":80,"rows":201}', '{"t":"resize","cols":80.5,"rows":24}', '{"t":"kill"}']) expect(parseTerminalFrame(bad)).toBeNull();
    expect(parseTerminalFrame(JSON.stringify({ t: "in", d: "x".repeat(70_000) }))).toBeNull();
  });
});

describe("scrollback", () => {
  test("keeps the newest bytes under its cap", () => {
    const ring = new Scrollback(10);
    ring.push(Buffer.from("abcdef"));
    ring.push(Buffer.from("ghijkl"));
    expect(ring.bytes().toString()).toBe("cdefghijkl");
    ring.push(Buffer.from("0123456789XY"));
    expect(ring.bytes().toString()).toBe("23456789XY");
  });
});

describe.skipIf(process.platform === "win32")("a terminal host", () => {
  let dir: string, repo: string, host: TerminalHost;
  const events: string[] = [];
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "so-term-")));
    repo = join(dir, "repo");
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "base"]);
    events.length = 0;
    host = new TerminalHost({ spawn: spawn!, worktreeRoot: join(dir, "live"), closeGraceMs: 300,
      programs: { shell: { file: "/bin/sh", args: [] }, claude: { file: "/bin/cat", args: [] } },
      env: () => ({ PATH: process.env["PATH"] ?? "", HOME: dir }), record: (event, one) => events.push(`${event}:${one.program}`) });
  });
  afterEach(async () => { await host.stop(); rmSync(dir, { recursive: true, force: true }); });

  const watcher = () => {
    const seen = { out: "", controls: [] as TerminalControl[] };
    return { seen, viewer: { output: (data: Buffer) => { seen.out += data.toString(); }, control: (message: TerminalControl) => { seen.controls.push(message); } } };
  };
  const until = async (check: () => boolean, ms = 4000) => {
    const end = Date.now() + ms;
    while (!check()) { if (Date.now() > end) throw new Error("timed out"); await new Promise(resolve => setTimeout(resolve, 20)); }
  };

  test("runs in its own worktree on its own branch, and echoes what is typed", async () => {
    const started = await host.start(ALEX, repo, "claude");
    expect(started.branch).toMatch(/^toolroll\/live-[0-9a-f]{12}$/);
    expect(existsSync(started.worktree)).toBe(true);
    expect(execFileSync("git", ["-C", started.worktree, "branch", "--show-current"]).toString().trim()).toBe(started.branch);
    const { seen, viewer } = watcher();
    host.attach(started.id, viewer);
    expect(seen.controls[0]).toMatchObject({ t: "hello", program: "claude", ended: false });
    host.input(started.id, "hello there\r");
    await until(() => seen.out.includes("hello there"));
    expect(events).toEqual(["start:claude"]);
  });

  test("a page that attaches later gets the scrollback first", async () => {
    const started = await host.start(ALEX, repo, "shell");
    host.input(started.id, "echo mark-$((6*7))\n");
    const first = watcher();
    host.attach(started.id, first.viewer);
    await until(() => first.seen.out.includes("mark-42"));
    const late = watcher();
    host.attach(started.id, late.viewer);
    expect(late.seen.out).toContain("mark-42");
    expect(late.seen.controls[0]?.t).toBe("hello");
  });

  test("close ends the whole process group, and says so", async () => {
    const started = await host.start(ALEX, repo, "shell");
    const { seen, viewer } = watcher();
    host.attach(started.id, viewer);
    // A background child that ignores SIGHUP is still in the group: SIGKILL after the grace takes it.
    host.input(started.id, "trap '' HUP; sleep 60 & echo child=$!\n");
    await until(() => /child=\d+/.test(seen.out));
    const child = Number(/child=(\d+)/.exec(seen.out)![1]);
    await host.close(started.id);
    await until(() => { try { process.kill(child, 0); return false; } catch { return true; } });
    expect(seen.controls.at(-1)?.t).toBe("exit");
    expect(host.get(started.id)).toMatchObject({ endedBy: "owner" });
    expect(host.list("alex")).toHaveLength(1);
    expect(host.list("someone-else")).toHaveLength(0);
  });

  test("a program that ignores SIGHUP is killed after the grace", async () => {
    const started = await host.start(ALEX, repo, "shell");
    const { seen, viewer } = watcher();
    host.attach(started.id, viewer);
    host.input(started.id, "trap '' HUP; echo armed\n");
    await until(() => seen.out.includes("armed"));
    const at = Date.now();
    await host.close(started.id);
    expect(Date.now() - at).toBeGreaterThanOrEqual(250);
    expect(host.get(started.id)).toMatchObject({ cleanup: "clean" });
    expect(host.get(started.id)!.exit).not.toBeNull();
  });

  test("at most four pages attach to one terminal", async () => {
    const started = await host.start(ALEX, repo, "shell");
    for (let n = 0; n < 4; n += 1) host.attach(started.id, watcher().viewer);
    expect(() => host.attach(started.id, watcher().viewer)).toThrow(/open in 4 places/);
  });

  test("a project whose git config can run a command starts nothing (hardened git)", async () => {
    execFileSync("git", ["-C", repo, "config", "core.pager", "touch /tmp/so-pwned"]);
    await expect(host.start(ALEX, repo, "shell")).rejects.toThrow(/won't run git in this project: .*core\.pager/);
    expect(host.list("alex")).toHaveLength(0);
    expect(execFileSync("git", ["-C", repo, "worktree", "list"]).toString().trim().split("\n")).toHaveLength(1);
  });

  test("remove drops an ended session and its worktree, keeps the branch", async () => {
    const started = await host.start(ALEX, repo, "shell");
    await expect(host.remove(started.id)).rejects.toThrow(/Close the terminal/);
    await host.close(started.id);
    await host.remove(started.id);
    expect(host.get(started.id)).toBeNull();
    expect(existsSync(started.worktree)).toBe(false);
    expect(execFileSync("git", ["-C", repo, "branch", "--list", started.branch]).toString()).toContain(started.branch);
  });

  test("at most the cap run at once; a missing program or a non-root folder starts nothing", async () => {
    const small = new TerminalHost({ spawn: spawn!, worktreeRoot: join(dir, "small"), maxSessions: 1, closeGraceMs: 300, programs: { shell: { file: "/bin/sh", args: [] } }, env: () => ({ PATH: "" }) });
    try {
      await small.start(ALEX, repo, "shell");
      await expect(small.start(ALEX, repo, "shell")).rejects.toThrow(/At most 1/);
      await expect(new TerminalHost({ spawn: spawn!, worktreeRoot: join(dir, "x"), env: () => ({ PATH: "" }) }).start(ALEX, repo, "codex")).rejects.toThrow(/isn't installed/);
      execFileSync("mkdir", ["-p", join(repo, "sub")]);
      await expect(host.start(ALEX, join(repo, "sub"), "shell")).rejects.toThrow(/root of a Git project/);
    } finally { await small.stop(); }
  });
});
