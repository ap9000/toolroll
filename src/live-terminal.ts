/**
 * Live terminals (docs/plans/live-terminal.md): `claude`, `codex` or a shell running interactively in a real
 * pseudo-terminal, in its own worktree, hosted by the console and streamed to the person's browser.
 *
 * The person drives; nothing here is unattended and nothing here spends on Toolroll's behalf. A session lives
 * while the console runs, attached or not, and ends when its program exits, its owner closes it, or the console
 * stops. Sessions are in memory; the worktree and its branch outlive them.
 */
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { codingEnvironment } from "./coding-provider.js";
import { teardownGit, refusal, type Git } from "./teardown-git.js";

export type TerminalProgram = "claude" | "codex" | "shell";
export const TERMINAL_PROGRAMS: readonly TerminalProgram[] = ["claude", "codex", "shell"];

/** At most this many running sessions per console, and this many kept at all (ended ones count until removed). */
export const MAX_LIVE_TERMINALS = 8;
export const MAX_KEPT_TERMINALS = 16;
/** At most this many pages attached to one session (a desktop, a phone, a spare tab or two). */
export const MAX_VIEWERS = 4;
/** Raw output kept per session for a page that attaches later. */
export const SCROLLBACK_BYTES = 1024 * 1024;
/** After SIGHUP, the terminal's processes have this long before SIGKILL. */
export const CLOSE_GRACE_MS = 2_000;
/** Typed input not yet read by the program, per terminal: past this, more is refused until it reads. */
export const MAX_PENDING_INPUT = 1024 * 1024;
/** How often a running terminal's processes are noted, so ones that outlive their parent are still known. */
export const CUSTODY_REFRESH_MS = 5_000;
export const COLS = { min: 2, max: 500 } as const;
export const ROWS = { min: 1, max: 200 } as const;

/** The slice of node-pty this module uses, so tests can stand a fake in. */
export type Pty = {
  readonly pid: number;
  /** The terminal device its processes have as their controlling terminal ("ttys012", "pts/3"); null when unknown. */
  readonly tty: string | null;
  /** Typed bytes queued for the program and not yet taken by the kernel; Infinity when it can't be measured. */
  pendingInput(): number;
  onData(listener: (data: string) => void): unknown;
  onExit(listener: (exit: { exitCode: number; signal?: number }) => void): unknown;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
};
export type PtySpawn = (file: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; cols: number; rows: number }) => Pty;

/** A device path as `ps` prints it: /dev/ttys012 → ttys012, /dev/pts/3 → pts/3. */
export const ttyName = (path: unknown): string | null => typeof path === "string" && /^\/dev\/(ttys\d+|pts\/\d+|tty[a-z]?\d+)$/.test(path) ? path.slice(5) : null;

/**
 * node-pty's write queue (@lydell/node-pty 1.2.0-beta.15, pinned exactly): typed input waits in its
 * `_writeStream._writeQueue` until the kernel takes it. A shape this doesn't recognise is unmeasurable: Infinity, so
 * input is refused rather than queued without bound (a test pins the shape against the installed package).
 */
export function pendingInputOf(pty: unknown): number {
  const queue = (pty as { _writeStream?: { _writeQueue?: unknown } })?._writeStream?._writeQueue;
  if (!Array.isArray(queue)) return Infinity;
  let bytes = 0;
  for (const task of queue as Array<{ buffer?: unknown; offset?: unknown }>) {
    if (!Buffer.isBuffer(task?.buffer) || typeof task.offset !== "number") return Infinity;
    bytes += task.buffer.byteLength - task.offset;
  }
  return bytes;
}

/** node-pty, if this install has it (an optional dependency with prebuilt binaries); null when it doesn't load. */
export function loadPtySpawn(): PtySpawn | null {
  try {
    const pty = createRequire(import.meta.url)("@lydell/node-pty") as typeof import("@lydell/node-pty");
    return (file, args, options) => {
      const native = pty.spawn(file, args, { name: "xterm-256color", cwd: options.cwd, env: options.env as Record<string, string>, cols: options.cols, rows: options.rows });
      return {
        get pid() { return native.pid; },
        tty: ttyName((native as unknown as { ptsName?: unknown }).ptsName),
        pendingInput: () => pendingInputOf(native),
        onData: listener => native.onData(listener),
        onExit: listener => native.onExit(listener),
        write: data => native.write(data),
        resize: (cols, rows) => native.resize(cols, rows),
        kill: signal => native.kill(signal),
      };
    };
  } catch {
    return null;
  }
}

/** Raw output, oldest dropped first, never more than `cap` bytes. */
export class Scrollback {
  private chunks: Buffer[] = [];
  private size = 0;
  constructor(private readonly cap = SCROLLBACK_BYTES) {}
  push(chunk: Buffer): void {
    if (chunk.length >= this.cap) { this.chunks = [chunk.subarray(chunk.length - this.cap)]; this.size = this.cap; return; }
    this.chunks.push(chunk);
    this.size += chunk.length;
    while (this.size > this.cap) {
      const first = this.chunks[0]!;
      const over = this.size - this.cap;
      if (first.length <= over) { this.chunks.shift(); this.size -= first.length; }
      else { this.chunks[0] = first.subarray(over); this.size -= over; }
    }
  }
  bytes(): Buffer { return Buffer.concat(this.chunks, this.size); }
  get length(): number { return this.size; }
}

/** One attached page. The host never waits on it. */
export type TerminalViewer = {
  output(data: Buffer): void;
  control(message: TerminalControl): void;
};
export type TerminalControl =
  | { t: "hello"; cols: number; rows: number; program: TerminalProgram; ended: boolean }
  | { t: "exit"; code: number | null; signal: number | null }
  /** The program isn't reading what's typed: input waits until it does. */
  | { t: "input-full" };

export type TerminalSummary = {
  id: string;
  owner: string;
  /** The owner's account generation at start: a rotated credential or a re-sign-in elsewhere no longer reaches it. */
  generation: number;
  repo: string;
  program: TerminalProgram;
  branch: string;
  worktree: string;
  startedAt: string;
  endedAt: string | null;
  exit: { code: number | null; signal: number | null } | null;
  /** Who ended it, when Toolroll did. */
  endedBy: "owner" | "console" | null;
  /**
   * After it ends: "clean" once every process known to be its own is proved gone; "uncertain" when one outlived
   * SIGKILL or the process table couldn't be read. Null while it runs or is being swept.
   */
  cleanup: "clean" | "uncertain" | null;
};

type Session = TerminalSummary & {
  pty: Pty | null;
  /** The program's own process (it leads the terminal's session and process group) and its terminal device. */
  leader: number;
  tty: string | null;
  /** Every process seen as this terminal's, by pid and start time: kept after its parent exits. */
  known: Map<number, string>;
  exitedAt: number | null;
  /** The worktree's real path and the program's start, for finding jobs left in it. */
  worktreeReal: string;
  startedMs: number;
  /** The sweep proved its own processes gone, and only someone else's work in the worktree kept it from "clean". */
  residentsOnly: boolean;
  residentsSeen: Map<number, string>;
  cols: number;
  rows: number;
  scrollback: Scrollback;
  viewers: Set<TerminalViewer>;
  closing: Promise<void> | null;
  exited: Promise<void>;
};

/**
 * Where a console's terminals are written down for the updater, which runs as another process (terminal-catalog.ts):
 * a start is reserved before any work and refused while an update owns admission; a program is running until its
 * sweep ends. The default keeps nothing (tests, a console without a database file).
 */
export type TerminalLedger = {
  /** Throws (with the reason in words) when no terminal may start now. */
  reserve(id: string): void;
  running(id: string): void;
  release(id: string, cleanup: "clean" | "uncertain" | null): void;
  /** The terminal is removed (its worktree went after a clean sweep): nothing of it is left to count. */
  forget(id: string): void;
};
const NO_LEDGER: TerminalLedger = { reserve() {}, running() {}, release() {}, forget() {} };

export class TerminalError extends Error {
  constructor(message: string) { super(message); this.name = "TerminalError"; }
}

export type TerminalHostOptions = {
  spawn: PtySpawn;
  worktreeRoot: string;
  /** Git for making and removing worktrees: hardened by default (teardown-git.ts), since a build can write .git/config. */
  git?: Git;
  /** How each program starts; the default looks up `claude`, `codex` and the login shell on PATH. */
  programs?: Partial<Record<TerminalProgram, { file: string; args: string[] }>>;
  env?: () => NodeJS.ProcessEnv;
  clock?: () => Date;
  /** Start, close and remove, for the event log (never input or output). */
  record?: (event: "start" | "close" | "remove" | "exit", session: TerminalSummary) => void;
  maxSessions?: number;
  scrollbackBytes?: number;
  closeGraceMs?: number;
  ledger?: TerminalLedger;
  /** The process table (tests stand a failing one in); null when it can't be read. */
  processes?: () => ProcessTable | null;
  /** Who else works in a worktree (tests stand theirs in); default worktreeResidents. */
  residents?: (table: ProcessTable, worktreeReal: string) => Set<number> | null;
};

const clamp = (value: number, range: { min: number; max: number }) => Math.min(range.max, Math.max(range.min, Math.trunc(value)));

/** The executable on PATH, or null. */
export function onPath(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (isAbsolute(name)) return existsSync(name) ? name : null;
  const extensions = process.platform === "win32" ? (env["PATHEXT"] ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of (env["PATH"] ?? "").split(delimiter)) {
    if (dir === "") continue;
    for (const extension of extensions) {
      const path = join(dir, name + extension);
      try { if (statSync(path).isFile()) return path; } catch { /* not here */ }
    }
  }
  return null;
}

function defaultProgram(program: TerminalProgram, env: NodeJS.ProcessEnv): { file: string; args: string[] } | null {
  if (program === "shell") {
    if (process.platform === "win32") return { file: onPath("pwsh", env) ?? onPath("powershell", env) ?? "cmd.exe", args: [] };
    const shell = env["SHELL"];
    const file = shell !== undefined && isAbsolute(shell) && existsSync(shell) ? shell : onPath("bash", env) ?? "/bin/sh";
    return { file, args: ["-l"] };
  }
  const file = onPath(program, env);
  return file === null ? null : { file, args: [] };
}

export class TerminalHost {
  private readonly sessions = new Map<string, Session>();
  private starting = 0;
  private stopped = false;
  private readonly clock: () => Date;
  private readonly env: () => NodeJS.ProcessEnv;
  private readonly ledger: TerminalLedger;
  private readonly processes: () => ProcessTable | null;
  private custodyTimer: NodeJS.Timeout | null = null;

  constructor(private readonly options: TerminalHostOptions) {
    this.clock = options.clock ?? (() => new Date());
    this.env = options.env ?? codingEnvironment;
    this.ledger = options.ledger ?? NO_LEDGER;
    this.processes = options.processes ?? readProcessTable;
  }

  private summary(session: Session): TerminalSummary {
    const { id, owner, generation, repo, program, branch, worktree, startedAt, endedAt, exit, endedBy, cleanup } = session;
    return { id, owner, generation, repo, program, branch, worktree, startedAt, endedAt, exit, endedBy, cleanup };
  }

  /** This person's sessions, newest first. */
  list(owner: string): TerminalSummary[] {
    return [...this.sessions.values()].filter(one => one.owner === owner).map(one => this.summary(one)).reverse();
  }

  get(id: string): TerminalSummary | null {
    const session = this.sessions.get(id);
    return session === undefined ? null : this.summary(session);
  }

  private running(): number {
    return [...this.sessions.values()].filter(one => one.endedAt === null).length;
  }

  /**
   * Make the worktree and start the program in it. `admit` is asked again right before the program starts (after the
   * slow git work): a person whose access or project went in between starts nothing.
   */
  async start({ name: owner, generation }: { name: string; generation: number }, repoPath: string, program: TerminalProgram,
    size: { cols: number; rows: number } = { cols: 100, rows: 30 }, admit: () => string | null = () => null): Promise<TerminalSummary> {
    if (this.stopped) throw new TerminalError("The console is stopping.");
    if (!TERMINAL_PROGRAMS.includes(program)) throw new TerminalError("Choose Claude, Codex or a shell.");
    if (this.running() + this.starting >= (this.options.maxSessions ?? MAX_LIVE_TERMINALS)) throw new TerminalError(`At most ${this.options.maxSessions ?? MAX_LIVE_TERMINALS} terminals can run at once. Close one first.`);
    if (this.sessions.size + this.starting >= MAX_KEPT_TERMINALS) throw new TerminalError(`${MAX_KEPT_TERMINALS} terminals are kept already. Remove an ended one first.`);
    const env = { ...this.env(), TERM: "xterm-256color", COLORTERM: "truecolor" };
    const command = this.options.programs?.[program] ?? defaultProgram(program, env);
    if (command === null) throw new TerminalError(`${program === "claude" ? "Claude Code" : "Codex"} isn't installed on this computer (\`${program}\` is not on PATH).`);
    const id = randomBytes(16).toString("hex");
    // The slot is held, here and for the updater, before any slow work.
    this.starting += 1;
    let reserved = false;
    try {
      try { this.ledger.reserve(id); reserved = true; }
      catch (error) { throw error instanceof TerminalError ? error : new TerminalError(error instanceof Error ? error.message : "No terminal can start right now."); }
      let repo: string;
      try { repo = realpathSync(repoPath); } catch { throw new TerminalError("That project folder is gone."); }
      const hardened = this.options.git ?? teardownGit();
      const git = async (args: string[]) => {
        const result = await hardened(repo, args);
        if (result.code !== 0) throw new TerminalError(refusal(result) !== null ? `Toolroll won't run git in this project: ${refusal(result)}.` : "Git couldn't make a worktree for this terminal. Check the project and try again.");
        return result.stdout.trim();
      };
      if (realpathSync(await git(["rev-parse", "--show-toplevel"])) !== repo) throw new TerminalError("Choose the root of a Git project.");
      const base = await git(["rev-parse", "--verify", "HEAD^{commit}"]);
      const branch = `toolroll/live-${id.slice(0, 12)}`;
      const worktree = join(this.options.worktreeRoot, id);
      mkdirSync(this.options.worktreeRoot, { recursive: true, mode: 0o700 });
      await git(["worktree", "add", "-b", branch, "--", worktree, base]);
      const cols = clamp(size.cols, COLS), rows = clamp(size.rows, ROWS);
      let pty: Pty;
      try {
        if (this.stopped) throw new TerminalError("The console is stopping.");
        const refused = admit();
        if (refused !== null) throw new TerminalError(refused);
        pty = this.options.spawn(command.file, command.args, { cwd: worktree, env, cols, rows });
      } catch (error) {
        // Nothing ran in it: take the worktree and branch back.
        await git(["worktree", "remove", "--force", "--", worktree]).catch(() => {});
        await git(["branch", "-D", "--", branch]).catch(() => {});
        throw error instanceof TerminalError ? error : new TerminalError(`The program couldn't start: ${error instanceof Error ? error.message : String(error)}`);
      }
      let resolveExited!: () => void;
      const session: Session = { id, owner, generation, repo, program, branch, worktree, startedAt: this.clock().toISOString(), endedAt: null, exit: null, endedBy: null, cleanup: null,
        pty, leader: pty.pid, tty: pty.tty, known: new Map(), exitedAt: null, worktreeReal: realpathSync(worktree), startedMs: Date.now(), residentsOnly: false, residentsSeen: new Map(), cols, rows, scrollback: new Scrollback(this.options.scrollbackBytes), viewers: new Set(), closing: null,
        exited: new Promise(resolve => { resolveExited = resolve; }) };
      this.sessions.set(id, session);
      this.ledger.running(id);
      reserved = false;
      this.noteCustody();
      pty.onData(data => {
        this.noteSoon();
        const chunk = Buffer.from(data, "utf8");
        session.scrollback.push(chunk);
        for (const viewer of session.viewers) { try { viewer.output(chunk); } catch { /* the viewer's own close handles it */ } }
      });
      pty.onExit(({ exitCode, signal }) => {
        session.pty = null;
        session.exitedAt = Date.now();
        session.endedAt = this.clock().toISOString();
        session.exit = { code: exitCode ?? null, signal: signal || null };
        for (const viewer of session.viewers) { try { viewer.control({ t: "exit", code: session.exit.code, signal: session.exit.signal }); } catch { /* gone */ } }
        this.options.record?.("exit", this.summary(session));
        resolveExited();
        // A program that ended on its own takes its jobs with it, as closing a terminal window does.
        if (session.closing === null) session.closing = this.sweep(session);
      });
      this.options.record?.("start", this.summary(session));
      return this.summary(session);
    } finally {
      this.starting -= 1;
      if (reserved) this.ledger.release(id, null);
    }
  }

  /** Attach a page: it gets the scrollback, then `hello`, then live output. Returns its detach. */
  attach(id: string, viewer: TerminalViewer): () => void {
    const session = this.sessions.get(id);
    if (session === undefined) throw new TerminalError("No such terminal.");
    if (session.viewers.size >= MAX_VIEWERS) throw new TerminalError(`This terminal is open in ${MAX_VIEWERS} places already. Close one of them.`);
    const replay = session.scrollback.bytes();
    if (replay.length > 0) viewer.output(replay);
    viewer.control({ t: "hello", cols: session.cols, rows: session.rows, program: session.program, ended: session.endedAt !== null });
    if (session.exit !== null) viewer.control({ t: "exit", code: session.exit.code, signal: session.exit.signal });
    session.viewers.add(viewer);
    return () => { session.viewers.delete(viewer); };
  }

  /** How many pages are attached now. */
  viewerCount(id: string): number { return this.sessions.get(id)?.viewers.size ?? 0; }

  /** Type into the program. False (nothing queued) while it has MAX_PENDING_INPUT unread, or can't be measured. */
  input(id: string, data: string): boolean {
    const pty = this.sessions.get(id)?.pty;
    if (pty == null) return true;
    if (pty.pendingInput() + Buffer.byteLength(data) > MAX_PENDING_INPUT) return false;
    pty.write(data);
    this.noteSoon();
    return true;
  }

  resize(id: string, cols: number, rows: number): void {
    const session = this.sessions.get(id);
    if (session?.pty == null) return;
    session.cols = clamp(cols, COLS);
    session.rows = clamp(rows, ROWS);
    try { session.pty.resize(session.cols, session.rows); } catch { /* it exited between */ }
  }

  private noteTimer: NodeJS.Timeout | null = null;
  /** Activity (output, typing) usually means a command started: note processes shortly after, at most every 250 ms. */
  private noteSoon(): void {
    if (this.noteTimer !== null) return;
    this.noteTimer = setTimeout(() => { this.noteTimer = null; this.noteCustody(); }, 250);
    this.noteTimer.unref?.();
  }

  /** Note every running terminal's processes now, and keep doing so while any runs. */
  private noteCustody(): void {
    const live = [...this.sessions.values()].filter(one => one.endedAt === null);
    if (live.length > 0) {
      const table = this.processes();
      if (table !== null) for (const session of live) for (const [pid, started] of membersOf(table, session)) session.known.set(pid, started);
    }
    if (live.length > 0 && this.custodyTimer === null) {
      this.custodyTimer = setInterval(() => this.noteCustody(), CUSTODY_REFRESH_MS);
      this.custodyTimer.unref?.();
    } else if (live.length === 0 && this.custodyTimer !== null) {
      clearInterval(this.custodyTimer);
      this.custodyTimer = null;
    }
  }

  /**
   * End the program and everything that is its own: SIGHUP to every member (an interactive shell gives each job its own
   * process group, so the leader's group is not enough), then SIGKILL, re-reading the process table each time so a
   * child started during the close is caught too. Membership is the leader's descendants, every process with this
   * terminal as its controlling terminal (started before the program ended), and every one noted while it ran, by pid
   * and start time. A process that detached itself from the terminal AND its parents before it was noted is not seen —
   * the same as any terminal. Resolves when the sweep is done; never waits without bound.
   */
  close(id: string, by: "owner" | "console" = "owner"): Promise<void> {
    const session = this.sessions.get(id);
    if (session === undefined) return Promise.resolve();
    if (session.closing !== null) return session.closing;
    session.endedBy = by;
    this.options.record?.("close", this.summary(session));
    session.closing = this.sweep(session);
    return session.closing;
  }

  private async sweep(session: Session): Promise<void> {
    const grace = this.options.closeGraceMs ?? CLOSE_GRACE_MS;
    const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
    const leaderGone = () => session.pty === null;
    let readable = true;
    const members = (): Map<number, string> => {
      const table = this.processes();
      if (table === null) { readable = false; return new Map(); }
      const found = membersOf(table, session);
      for (const [pid, started] of found) session.known.set(pid, started);
      return found;
    };
    const signal = (found: ReadonlyMap<number, string>, name: "SIGHUP" | "SIGKILL") => {
      if (!leaderGone()) { try { process.kill(-session.leader, name); } catch { /* gone */ } try { session.pty?.kill(name); } catch { /* gone */ } }
      for (const pid of found.keys()) { try { process.kill(pid, name); } catch { /* gone */ } }
    };
    let cleanup: "clean" | "uncertain" = "uncertain";
    try {
      if (process.platform === "win32") {
        try { session.pty?.kill(); } catch { /* gone */ }
        await Promise.race([session.exited, pause(grace)]);
        cleanup = leaderGone() ? "clean" : "uncertain";
        return;
      }
      signal(members(), "SIGHUP");
      for (const deadline = Date.now() + grace; Date.now() < deadline;) {
        await pause(100);
        if (leaderGone() && members().size === 0 && readable) { cleanup = "clean"; return; }
      }
      for (let round = 0; round < 20; round += 1) {
        const found = members();
        if (!readable) return;
        if (found.size === 0 && leaderGone()) { cleanup = "clean"; return; }
        signal(found, "SIGKILL");
        await pause(100);
      }
    } finally {
      // The leader's exit is waited for, but never without bound.
      await Promise.race([session.exited, pause(1_000)]);
      // Proven members gone is not enough to free the worktree: nothing of this user may still be working in it.
      if (cleanup === "clean") {
        const table = this.processes();
        const residents = table === null ? null : (this.options.residents ?? worktreeResidents)(table, session.worktreeReal);
        if (residents === null || residents.size > 0) {
          cleanup = "uncertain";
          session.residentsOnly = residents !== null;
          // Who was there, by pid and start time: removal waits for each to exit, not merely to leave the folder.
          for (const pid of residents ?? []) { const row = table!.get(pid); if (row !== undefined) session.residentsSeen.set(pid, row.started); }
        }
      }
      session.cleanup = readable && leaderGone() ? cleanup : "uncertain";
      if (session.endedAt === null) session.endedAt = this.clock().toISOString();
      this.ledger.release(session.id, session.cleanup);
      this.noteCustody();
    }
  }

  /** Drop an ended session and its worktree (the branch stays: the work is there). Only after a clean sweep. */
  async remove(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (session === undefined) return;
    if (session.pty !== null) throw new TerminalError("Close the terminal before removing it.");
    if (session.closing !== null) await session.closing;
    const busy = new TerminalError("Something may still be running in this terminal's worktree, so the worktree stays. Stop it (or leave the folder), then remove the worktree with `git worktree remove`.");
    // Uncertain only because someone else was working in the worktree: it may go once they have left (checked below).
    if (session.cleanup !== "clean" && !session.residentsOnly) throw busy;
    // Checked again now: a shell or server may have moved into the worktree since the sweep.
    const table = this.processes();
    const residents = table === null ? null : (this.options.residents ?? worktreeResidents)(table, session.worktreeReal);
    if (residents === null || residents.size > 0) throw busy;
    // Each process seen working in it when the sweep ended must have exited (the same pid with the same start time is
    // the same process, wherever it now works).
    if ([...session.residentsSeen].some(([pid, started]) => table!.get(pid)?.started === started)) throw busy;
    this.sessions.delete(id);
    this.ledger.forget(id);
    for (const viewer of session.viewers) { try { viewer.control({ t: "exit", code: session.exit?.code ?? null, signal: session.exit?.signal ?? null }); } catch { /* gone */ } }
    session.viewers.clear();
    const result = await (this.options.git ?? teardownGit())(session.repo, ["worktree", "remove", "--force", "--", session.worktree]);
    this.options.record?.("remove", this.summary(session));
    if (result.code !== 0 && existsSync(session.worktree)) {
      const why = refusal(result);
      throw new TerminalError(`The terminal is gone, but its worktree stays${why === null ? "" : ` (${why})`}. Remove it with \`git worktree remove\`.`);
    }
  }

  /** Whether new sessions may start (false once the console is stopping). */
  get admitting(): boolean { return !this.stopped; }

  /**
   * The console is stopping: admit nothing more, end every program, and wait (each sweep is bounded) for them.
   * `clean` is false when any terminal's processes couldn't be proved gone.
   */
  async stop(): Promise<{ clean: boolean }> {
    this.stopped = true;
    await Promise.all([...this.sessions.keys()].map(id => this.close(id, "console")));
    if (this.custodyTimer !== null) { clearInterval(this.custodyTimer); this.custodyTimer = null; }
    if (this.noteTimer !== null) { clearTimeout(this.noteTimer); this.noteTimer = null; }
    return { clean: [...this.sessions.values()].every(one => one.cleanup === "clean") };
  }
}

/** One process: its parent, owner, controlling terminal and start time. */
export type ProcessTable = Map<number, { ppid: number; uid: number; tty: string; started: string }>;

/** Every process from `ps` (macOS and Linux take these options); null when it can't be read, never an empty guess. */
export function readProcessTable(): ProcessTable | null {
  let text: string;
  try { text = execFileSync("ps", ["-A", "-o", "pid=,ppid=,uid=,tty=,lstart="], { encoding: "utf8", timeout: 2_000, maxBuffer: 8 * 1024 * 1024 }); } catch { return null; }
  const table: ProcessTable = new Map();
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    // uid -2 is macOS's "nobody".
    const match = /^\s*(\d+)\s+(\d+)\s+(-?\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
    if (match === null) return null;
    table.set(Number(match[1]), { ppid: Number(match[2]), uid: Number(match[3]), tty: match[4]!, started: match[5]! });
  }
  return table.size === 0 ? null : table;
}

/**
 * A terminal's processes in this table, by pid and start time: what was noted while it ran (still the same process),
 * the leader, everything whose controlling terminal is its terminal and that started before it ended (a later process
 * on a reused device is someone else's), and every descendant of those. Never this console itself.
 */
export function membersOf(table: ProcessTable, session: { leader: number; tty: string | null; known: ReadonlyMap<number, string>; exitedAt: number | null }): Map<number, string> {
  const found = new Map<number, string>();
  const startedMs = (started: string) => Date.parse(started);
  for (const [pid, row] of table) {
    if (pid === process.pid || pid <= 1) continue;
    const noted = session.known.get(pid);
    const ownTty = session.tty !== null && row.tty === session.tty && (session.exitedAt === null || startedMs(row.started) <= session.exitedAt + 1_000);
    // The leader by pid only while it runs: after it exits its pid may be someone else's (it is noted by start time).
    if (noted === row.started || (pid === session.leader && session.exitedAt === null) || ownTty) found.set(pid, row.started);
  }
  for (let grew = true; grew;) {
    grew = false;
    for (const [pid, row] of table) if (!found.has(pid) && pid !== process.pid && found.has(row.ppid)) { found.set(pid, row.started); grew = true; }
  }
  return found;
}

/** Each listed process's working directory (Linux: /proc; macOS: lsof). Null when they can't all be read: a timeout,
 * a signal or partial output is unreadable, never a smaller answer. A process gone in between is simply absent. */
export function cwdsOf(pids: readonly number[]): Map<number, string> | null {
  const cwds = new Map<number, string>();
  if (pids.length === 0) return cwds;
  if (process.platform === "linux") {
    for (const pid of pids) {
      try { cwds.set(pid, readlinkSync(`/proc/${pid}/cwd`)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null; }
    }
    return cwds;
  }
  let text: string;
  try { text = execFileSync("lsof", ["-a", "-d", "cwd", "-Fpn", "-p", pids.join(",")], { encoding: "utf8", timeout: 10_000, maxBuffer: 16 * 1024 * 1024 }); }
  catch (error) {
    // lsof exits 1 (and nothing else) when some listed process is gone; a timeout or a signal is unreadable.
    const failure = error as { status?: unknown; signal?: unknown; code?: unknown; stdout?: unknown };
    if (failure.status !== 1 || failure.signal != null || failure.code === "ETIMEDOUT" || typeof failure.stdout !== "string") return null;
    text = failure.stdout;
  }
  let pid: number | null = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && pid !== null) cwds.set(pid, line.slice(1));
  }
  return cwds;
}

/**
 * This user's processes working inside a terminal's worktree, whoever started them, other than the proven members
 * already being swept. They are never signalled (one may be the person's own shell or a server they started from
 * elsewhere); while any remains, the terminal's cleanup is uncertain and its worktree stays. Null when unreadable.
 */
export function worktreeResidents(table: ProcessTable, worktreeReal: string, exclude: ReadonlySet<number> = new Set()): Set<number> | null {
  const uid = process.getuid?.() ?? -1;
  const candidates = [...table].filter(([pid, row]) => pid !== process.pid && row.uid === uid && !exclude.has(pid)).map(([pid]) => pid);
  const cwds = cwdsOf(candidates);
  if (cwds === null) return null;
  return new Set([...cwds].filter(([, cwd]) => cwd === worktreeReal || cwd.startsWith(`${worktreeReal}/`)).map(([pid]) => pid));
}

/** One client frame, read strictly; null closes the socket. */
export type TerminalInput = { t: "in"; d: string } | { t: "resize"; cols: number; rows: number };
export const MAX_FRAME_BYTES = 64 * 1024;

export function parseTerminalFrame(text: string): TerminalInput | null {
  if (Buffer.byteLength(text) > MAX_FRAME_BYTES) return null;
  let value: unknown;
  try { value = JSON.parse(text); } catch { return null; }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const frame = value as Record<string, unknown>;
  const keys = Object.keys(frame).sort().join(",");
  if (frame["t"] === "in" && keys === "d,t" && typeof frame["d"] === "string") return { t: "in", d: frame["d"] };
  if (frame["t"] === "resize" && keys === "cols,rows,t") {
    const cols = frame["cols"], rows = frame["rows"];
    if (Number.isSafeInteger(cols) && Number.isSafeInteger(rows) && (cols as number) >= COLS.min && (cols as number) <= COLS.max && (rows as number) >= ROWS.min && (rows as number) <= ROWS.max) {
      return { t: "resize", cols: cols as number, rows: rows as number };
    }
  }
  return null;
}
