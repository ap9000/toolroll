/**
 * Live terminals (docs/plans/live-terminal.md): a real pty in its own worktree, scrollback replay, strict frames,
 * the session cap, and a close that takes the whole process group.
 */
import { describe, test, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { execFileSync, spawn as spawnChild } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { fakePid } from "../test/fake-pid.js";
import { createRequire } from "node:module";
import { loadPtySpawn, MAX_PENDING_INPUT, membersOf, parseTerminalFrame, pendingInputOf, Scrollback, TerminalHost, type PtySpawn, type TerminalControl, type TerminalLedger } from "./live-terminal.js";

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

  const gone = (pid: number) => { try { process.kill(pid, 0); return false; } catch { return true; } };

  test("a program that ends on its own takes its jobs with it, so its worktree can go (round 2, finding 2)", async () => {
    const started = await host.start(ALEX, repo, "shell");
    const { seen, viewer } = watcher();
    host.attach(started.id, viewer);
    host.input(started.id, "set +H; (trap '' HUP; exec sleep 60) & echo child=$! ; sleep 1; exit\n");
    await until(() => /child=\d+/.test(seen.out));
    const child = Number(/child=(\d+)/.exec(seen.out)![1]);
    await until(() => host.get(started.id)!.cleanup !== null);
    expect(host.get(started.id)).toMatchObject({ cleanup: "clean", endedBy: null });
    expect(gone(child)).toBe(true);
    await host.remove(started.id);
  });

  test("a child started during the close is caught too (round 2, finding 3)", async () => {
    const started = await host.start(ALEX, repo, "shell");
    const late = join(dir, "late.txt");
    const { seen, viewer } = watcher();
    host.attach(started.id, viewer);
    host.input(started.id, `(trap 'sleep 61 & echo $! > ${late}' HUP; while :; do sleep 0.1; done) & echo armed\n`);
    await until(() => seen.out.includes("armed"));
    await host.close(started.id);
    await until(() => { try { return readFileSync(late, "utf8").trim() !== ""; } catch { return false; } });
    expect(gone(Number(readFileSync(late, "utf8")))).toBe(true);
    expect(host.get(started.id)).toMatchObject({ cleanup: "clean" });
  });

  test("an unreadable process table is uncertain, never clean: the worktree stays and stop says so (round 2, findings 4 and 6)", async () => {
    let readable = true;
    const blind = new TerminalHost({ spawn: spawn!, worktreeRoot: join(dir, "blind"), closeGraceMs: 200, programs: { shell: { file: "/bin/sh", args: [] } },
      env: () => ({ PATH: process.env["PATH"] ?? "" }), processes: () => readable ? undefined as never : null });
    // The table reads normally until the close, then fails.
    const real = await import("./live-terminal.js");
    (blind as unknown as { processes: () => unknown }).processes = () => readable ? real.readProcessTable() : null;
    const started = await blind.start(ALEX, repo, "shell");
    readable = false;
    expect(await blind.stop()).toEqual({ clean: false });
    expect(blind.get(started.id)).toMatchObject({ cleanup: "uncertain" });
    await expect(blind.remove(started.id)).rejects.toThrow(/may still be running/);
    expect(existsSync(started.worktree)).toBe(true);
  });

  test("typing into a program that doesn't read stops at the cap (round 2, finding 5)", async () => {
    const deaf = new TerminalHost({ spawn: spawn!, worktreeRoot: join(dir, "deaf"), closeGraceMs: 200, programs: { shell: { file: "/bin/sleep", args: ["30"] } }, env: () => ({ PATH: "" }) });
    try {
      const started = await deaf.start(ALEX, repo, "shell");
      const chunk = "x".repeat(60_000);
      let refused = false;
      for (let n = 0; n < 40 && !refused; n += 1) refused = !deaf.input(started.id, chunk);
      expect(refused).toBe(true);
    } finally { await deaf.stop(); }
  });

  test("the pinned pty's write queue is measurable (an upgrade that hides it fails here, and input is refused)", () => {
    const native = (createRequire(import.meta.url)("@lydell/node-pty") as typeof import("@lydell/node-pty")).spawn("/bin/sleep", ["5"], { cols: 80, rows: 24, env: { PATH: "" } });
    try {
      expect(pendingInputOf(native)).toBe(0);
      expect(pendingInputOf({})).toBe(Infinity);
      expect(MAX_PENDING_INPUT).toBe(1024 * 1024);
    } finally { native.kill(); }
  });

  test("a start is reserved first, refused while an update owns admission, and released after its sweep (round 2, finding 7)", async () => {
    const calls: string[] = [];
    let paused = true;
    const ledger: TerminalLedger = { reserve: id => { if (paused) throw new Error("Toolroll is updating."); calls.push(`reserve:${id.length}`); }, running: () => { calls.push("running"); }, release: (_id, cleanup) => { calls.push(`release:${cleanup}`); } };
    const led = new TerminalHost({ spawn: spawn!, worktreeRoot: join(dir, "led"), closeGraceMs: 200, programs: { shell: { file: "/bin/sh", args: [] } }, env: () => ({ PATH: process.env["PATH"] ?? "" }), ledger });
    await expect(led.start(ALEX, repo, "shell")).rejects.toThrow(/updating/);
    expect(execFileSync("git", ["-C", repo, "worktree", "list"]).toString().trim().split("\n")).toHaveLength(1);
    paused = false;
    const started = await led.start(ALEX, repo, "shell");
    await led.close(started.id);
    expect(calls).toEqual(["reserve:32", "running", "release:clean"]);
  });

  test("an access check that fails right before spawn starts nothing (round 2, finding 8)", async () => {
    await expect(host.start(ALEX, repo, "shell", undefined, () => "That project is no longer available to your account.")).rejects.toThrow(/no longer available/);
    expect(host.list("alex")).toHaveLength(0);
    expect(execFileSync("git", ["-C", repo, "worktree", "list"]).toString().trim().split("\n")).toHaveLength(1);
    expect(execFileSync("git", ["-C", repo, "branch", "--list", "toolroll/live-*"]).toString().trim()).toBe("");
  });

  test("membership: noted by start time, the leader only while it runs, its terminal only before it ended", () => {
    const [P0, P1, P2, P3, P4, P5] = [0, 1, 2, 3, 4, 5].map(fakePid) as [number, number, number, number, number, number];
    const table = new Map([
      [P0, { ppid: 1, uid: 0, tty: "ttys009", started: "Tue Oct 20 10:00:00 2026" }],
      [P1, { ppid: P0, uid: 0, tty: "??", started: "Tue Oct 20 10:00:01 2026" }],
      [P2, { ppid: 1, uid: 0, tty: "??", started: "Tue Oct 20 10:00:02 2026" }],
      [P3, { ppid: 1, uid: 0, tty: "ttys009", started: "Tue Oct 20 11:00:00 2026" }],
      [P4, { ppid: 1, uid: 0, tty: "??", started: "Tue Oct 20 12:00:00 2026" }],
      [P5, { ppid: 1, uid: 0, tty: "??", started: "Tue Oct 20 10:10:00 2026" }],
    ]);
    const ended = Date.parse("Tue Oct 20 10:30:00 2026");
    expect([...membersOf(table, { leader: P4, tty: "ttys009", known: new Map([[P2, "Tue Oct 20 10:00:02 2026"]]), exitedAt: ended }).keys()].sort()).toEqual([P0, P1, P2]);
    expect([...membersOf(table, { leader: P4, tty: null, known: new Map([[P2, "a different start"]]), exitedAt: null }).keys()]).toEqual([P4]);
  });

  test("someone else working in the worktree is never signalled; it keeps the worktree until they leave (round 3)", async () => {
    const started = await host.start(ALEX, repo, "shell");
    const outsider = spawnChild("/bin/sleep", ["30"], { cwd: started.worktree, stdio: "ignore" });
    try {
      await until(() => outsider.pid !== undefined);
      await host.close(started.id);
      expect(gone(outsider.pid!)).toBe(false);
      expect(host.get(started.id)).toMatchObject({ cleanup: "uncertain" });
      await expect(host.remove(started.id)).rejects.toThrow(/may still be running/);
      expect(existsSync(started.worktree)).toBe(true);
    } finally { outsider.kill("SIGKILL"); }
    await until(() => gone(outsider.pid!));
    await host.remove(started.id);
    expect(existsSync(started.worktree)).toBe(false);
  });

  test("a process seen in the worktree must exit, not just leave the folder, before removal (round 4)", async () => {
    const started = await host.start(ALEX, repo, "shell");
    // It starts in the worktree, then moves out while it keeps running.
    const mover = spawnChild("/bin/sh", ["-c", "sleep 0.8; cd /; exec sleep 30"], { cwd: started.worktree, stdio: "ignore" });
    try {
      await until(() => mover.pid !== undefined);
      await host.close(started.id);
      expect(host.get(started.id)).toMatchObject({ cleanup: "uncertain" });
      await new Promise(resolve => setTimeout(resolve, 1200));
      await expect(host.remove(started.id)).rejects.toThrow(/may still be running/);
    } finally { mover.kill("SIGKILL"); }
    await until(() => gone(mover.pid!));
    await host.remove(started.id);
  });

  test("an unreadable list of who works in the worktree is uncertain", async () => {
    const unsure = new TerminalHost({ spawn: spawn!, worktreeRoot: join(dir, "unsure"), closeGraceMs: 200, programs: { shell: { file: "/bin/sh", args: [] } },
      env: () => ({ PATH: process.env["PATH"] ?? "" }), residents: () => null });
    const started = await unsure.start(ALEX, repo, "shell");
    expect(await unsure.stop()).toEqual({ clean: false });
    await expect(unsure.remove(started.id)).rejects.toThrow(/may still be running/);
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
