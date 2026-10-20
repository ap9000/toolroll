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
import { existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
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
/** After SIGHUP, the process group has this long before SIGKILL. */
export const CLOSE_GRACE_MS = 2_000;
export const COLS = { min: 2, max: 500 } as const;
export const ROWS = { min: 1, max: 200 } as const;

/** The slice of node-pty this module uses, so tests can stand a fake in. */
export type Pty = {
  readonly pid: number;
  onData(listener: (data: string) => void): unknown;
  onExit(listener: (exit: { exitCode: number; signal?: number }) => void): unknown;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
};
export type PtySpawn = (file: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; cols: number; rows: number }) => Pty;

/** node-pty, if this install has it (an optional dependency with prebuilt binaries); null when it doesn't load. */
export function loadPtySpawn(): PtySpawn | null {
  try {
    const pty = createRequire(import.meta.url)("@lydell/node-pty") as typeof import("@lydell/node-pty");
    return (file, args, options) => pty.spawn(file, args, { name: "xterm-256color", cwd: options.cwd, env: options.env as Record<string, string>, cols: options.cols, rows: options.rows });
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
  | { t: "exit"; code: number | null; signal: number | null };

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
  /** After a close: "clean" when every process from its tree is gone, "uncertain" when one outlived SIGKILL. */
  cleanup: "clean" | "uncertain" | null;
};

type Session = TerminalSummary & {
  pty: Pty | null;
  cols: number;
  rows: number;
  scrollback: Scrollback;
  viewers: Set<TerminalViewer>;
  closing: Promise<void> | null;
  exited: Promise<void>;
};

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

  constructor(private readonly options: TerminalHostOptions) {
    this.clock = options.clock ?? (() => new Date());
    this.env = options.env ?? codingEnvironment;
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

  /** Make the worktree and start the program in it. */
  async start({ name: owner, generation }: { name: string; generation: number }, repoPath: string, program: TerminalProgram, size: { cols: number; rows: number } = { cols: 100, rows: 30 }): Promise<TerminalSummary> {
    if (this.stopped) throw new TerminalError("The console is stopping.");
    if (!TERMINAL_PROGRAMS.includes(program)) throw new TerminalError("Choose Claude, Codex or a shell.");
    if (this.running() + this.starting >= (this.options.maxSessions ?? MAX_LIVE_TERMINALS)) throw new TerminalError(`At most ${this.options.maxSessions ?? MAX_LIVE_TERMINALS} terminals can run at once. Close one first.`);
    if (this.sessions.size + this.starting >= MAX_KEPT_TERMINALS) throw new TerminalError(`${MAX_KEPT_TERMINALS} terminals are kept already. Remove an ended one first.`);
    const env = { ...this.env(), TERM: "xterm-256color", COLORTERM: "truecolor" };
    const command = this.options.programs?.[program] ?? defaultProgram(program, env);
    if (command === null) throw new TerminalError(`${program === "claude" ? "Claude Code" : "Codex"} isn't installed on this computer (\`${program}\` is not on PATH).`);
    this.starting += 1;
    try {
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
      const id = randomBytes(16).toString("hex");
      const branch = `toolroll/live-${id.slice(0, 12)}`;
      const worktree = join(this.options.worktreeRoot, id);
      mkdirSync(this.options.worktreeRoot, { recursive: true, mode: 0o700 });
      await git(["worktree", "add", "-b", branch, "--", worktree, base]);
      const cols = clamp(size.cols, COLS), rows = clamp(size.rows, ROWS);
      let pty: Pty;
      try {
        if (this.stopped) throw new TerminalError("The console is stopping.");
        pty = this.options.spawn(command.file, command.args, { cwd: worktree, env, cols, rows });
      } catch (error) {
        // Nothing ran in it: take the worktree and branch back.
        await git(["worktree", "remove", "--force", "--", worktree]).catch(() => {});
        await git(["branch", "-D", "--", branch]).catch(() => {});
        throw error instanceof TerminalError ? error : new TerminalError(`The program couldn't start: ${error instanceof Error ? error.message : String(error)}`);
      }
      let resolveExited!: () => void;
      const session: Session = { id, owner, generation, repo, program, branch, worktree, startedAt: this.clock().toISOString(), endedAt: null, exit: null, endedBy: null, cleanup: null,
        pty, cols, rows, scrollback: new Scrollback(this.options.scrollbackBytes), viewers: new Set(), closing: null, exited: new Promise(resolve => { resolveExited = resolve; }) };
      this.sessions.set(id, session);
      pty.onData(data => {
        const chunk = Buffer.from(data, "utf8");
        session.scrollback.push(chunk);
        for (const viewer of session.viewers) { try { viewer.output(chunk); } catch { /* the viewer's own close handles it */ } }
      });
      pty.onExit(({ exitCode, signal }) => {
        session.pty = null;
        session.endedAt = this.clock().toISOString();
        session.exit = { code: exitCode ?? null, signal: signal || null };
        for (const viewer of session.viewers) { try { viewer.control({ t: "exit", code: session.exit.code, signal: session.exit.signal }); } catch { /* gone */ } }
        this.options.record?.("exit", this.summary(session));
        resolveExited();
      });
      this.options.record?.("start", this.summary(session));
      return this.summary(session);
    } finally {
      this.starting -= 1;
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

  input(id: string, data: string): void {
    this.sessions.get(id)?.pty?.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    const session = this.sessions.get(id);
    if (session?.pty == null) return;
    session.cols = clamp(cols, COLS);
    session.rows = clamp(rows, ROWS);
    try { session.pty.resize(session.cols, session.rows); } catch { /* it exited between */ }
  }

  /**
   * End the program and everything it started: SIGHUP to its whole process tree (an interactive shell puts each job
   * in its own process group, so the leader's group is not enough), then SIGKILL after the grace to anything from that
   * tree still running. A process that left the tree before the close (setsid and reparented) is not seen.
   * Resolves when the program has exited and the sweep is done.
   */
  close(id: string, by: "owner" | "console" = "owner"): Promise<void> {
    const session = this.sessions.get(id);
    if (session === undefined) return Promise.resolve();
    if (session.closing !== null) return session.closing;
    const pty = session.pty;
    if (pty === null) return session.exited;
    session.endedBy = by;
    this.options.record?.("close", this.summary(session));
    const grace = this.options.closeGraceMs ?? CLOSE_GRACE_MS;
    session.closing = (async () => {
      let leaderGone = false;
      void session.exited.then(() => { leaderGone = true; });
      if (process.platform === "win32") {
        try { pty.kill(); } catch { /* gone */ }
        await session.exited;
        return;
      }
      const tree = processTree(pty.pid);
      signalTree(pty.pid, tree, "SIGHUP");
      const deadline = Date.now() + grace;
      while (Date.now() < deadline && !(leaderGone && [...tree.keys()].every(pid => !alive(pid)))) await new Promise(resolve => setTimeout(resolve, 25));
      // Only what is still the same process (same start time) is killed: a recycled pid is someone else's.
      const now = processTree(null);
      const survivors = new Map([...tree].filter(([pid, started]) => now.get(pid) === started));
      if (!leaderGone || survivors.size > 0) signalTree(leaderGone ? null : pty.pid, survivors, "SIGKILL");
      await session.exited;
      // SIGKILL can't be refused, but delivery isn't instant: a moment, then what is still the same process is uncertain.
      const after = Date.now() + 500;
      const lingering = () => { const table = processTree(null); return [...survivors].some(([pid, started]) => table.get(pid) === started && alive(pid)); };
      while (Date.now() < after && survivors.size > 0 && lingering()) await new Promise(resolve => setTimeout(resolve, 25));
      session.cleanup = survivors.size > 0 && lingering() ? "uncertain" : "clean";
    })();
    return session.closing;
  }

  /** Drop an ended session and its worktree (the branch stays: the work is there). */
  async remove(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (session === undefined) return;
    if (session.endedAt === null) throw new TerminalError("Close the terminal before removing it.");
    if (session.closing !== null) await session.closing;
    if (session.cleanup === "uncertain") throw new TerminalError("Something this terminal started may still be running in its worktree, so the worktree stays. Check for it, then remove the worktree with `git worktree remove`.");
    this.sessions.delete(id);
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

  /** The console is stopping: admit nothing more, end every program, and wait (bounded by the grace) for them. */
  async stop(): Promise<void> {
    this.stopped = true;
    await Promise.all([...this.sessions.keys()].map(id => this.close(id, "console")));
  }
}

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; } };

/**
 * Every process and its start time; with a root, only that root and its descendants. Read from `ps` (macOS and
 * Linux both take these options). An unreadable table is an empty one: the group signal still goes out.
 */
export function processTree(root: number | null): Map<number, string> {
  const rows = new Map<number, { ppid: number; started: string }>();
  try {
    const text = execFileSync("ps", ["-A", "-o", "pid=,ppid=,lstart="], { encoding: "utf8", timeout: 2_000, maxBuffer: 8 * 1024 * 1024 });
    for (const line of text.split("\n")) {
      const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
      if (match !== null) rows.set(Number(match[1]), { ppid: Number(match[2]), started: match[3]! });
    }
  } catch { return new Map(); }
  if (root === null) return new Map([...rows].map(([pid, row]) => [pid, row.started]));
  const tree = new Map<number, string>();
  const rootRow = rows.get(root);
  if (rootRow === undefined) return tree;
  tree.set(root, rootRow.started);
  for (let grew = true; grew;) {
    grew = false;
    for (const [pid, row] of rows) if (!tree.has(pid) && tree.has(row.ppid)) { tree.set(pid, row.started); grew = true; }
  }
  return tree;
}

/** Signal the leader's group (when given) and every listed process. */
function signalTree(leader: number | null, tree: ReadonlyMap<number, string>, signal: "SIGHUP" | "SIGKILL"): void {
  if (leader !== null) { try { process.kill(-leader, signal); } catch { /* gone */ } }
  for (const pid of tree.keys()) { try { process.kill(pid, signal); } catch { /* gone */ } }
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
