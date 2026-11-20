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
import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { codingEnvironment } from "./coding-provider.js";
import { teardownGit, refusal, recordedCommonDir, TEARDOWN_FLAGS, type Git } from "./teardown-git.js";
import { run, type ExecResult } from "./exec.js";
import { ENV, ENV_ALLOWLIST } from "./remote-main.js";
import { sleep } from "./sleep.js";

export type TerminalProgram = "claude" | "codex" | "antigravity" | "shell";
export const TERMINAL_PROGRAMS: readonly TerminalProgram[] = ["claude", "codex", "antigravity", "shell"];

/** At most this many running sessions per console, and this many kept at all (ended ones count until removed). */
export const MAX_LIVE_TERMINALS = 8;
export const MAX_KEPT_TERMINALS = 16;
/** At most this many pages attached to one session (a desktop, a phone, a spare tab or two). */
export const MAX_VIEWERS = 4;
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
  /** Stop and start reading the program's output (flow control: the program blocks on a full terminal meanwhile). */
  pause?(): void;
  resume?(): void;
  /** Let go of typed bytes the program never read, when it is ending: they can't reach it, and writing them after the
   * terminal closes fails (EIO, EBADF) where nothing handles it. */
  dropInput?(): void;
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

/** Empty a pinned node-pty's queue of typed bytes not yet taken by the kernel, and cancel its next retry (the same
 * shape pendingInputOf reads). False when the shape isn't the pinned one (nothing is touched then). */
export function dropPendingInput(pty: unknown): boolean {
  const stream = (pty as { _writeStream?: { _writeQueue?: unknown; _writeImmediate?: unknown } })?._writeStream;
  if (stream === undefined || !Array.isArray(stream._writeQueue)) return false;
  stream._writeQueue.length = 0;
  if (stream._writeImmediate !== undefined) {
    clearImmediate(stream._writeImmediate as NodeJS.Immediate);
    stream._writeImmediate = undefined;
  }
  return true;
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
        pause: () => native.pause(),
        resume: () => native.resume(),
        dropInput: () => { dropPendingInput(native); },
      };
    };
  } catch {
    return null;
  }
}

/** How many lines above the screen a terminal keeps for a page that attaches later. */
export const SCREEN_SCROLLBACK_LINES = 5000;

type HeadlessTerminal = {
  write(data: string, callback?: () => void): void;
  resize(cols: number, rows: number): void;
  loadAddon(addon: unknown): void;
  dispose(): void;
};
type Serializer = { serialize(options?: { scrollback?: number }): string };
const require = createRequire(import.meta.url);

/**
 * The terminal as a page would see it now: every byte the program writes is parsed by a headless xterm here, so a page
 * that attaches later gets the screen, its scrollback and its modes (the alternate screen of a full-screen program, the
 * cursor, colours, bracketed paste, mouse reporting) — never a replay of raw output cut at an arbitrary byte, which
 * could split an escape sequence or redraw a full-screen program garbled.
 */
export class ScreenMirror {
  private readonly terminal: HeadlessTerminal;
  private readonly serializer: Serializer;
  constructor(cols: number, rows: number, private readonly lines = SCREEN_SCROLLBACK_LINES) {
    const { Terminal } = require("@xterm/headless") as { Terminal: new (options: Record<string, unknown>) => HeadlessTerminal };
    const { SerializeAddon } = require("@xterm/addon-serialize") as { SerializeAddon: new () => Serializer };
    this.terminal = new Terminal({ cols, rows, scrollback: lines, allowProposedApi: true });
    this.serializer = new SerializeAddon();
    this.terminal.loadAddon(this.serializer);
  }
  /** Bytes written and not yet parsed (xterm parses asynchronously): the host pauses the program while it grows. */
  pending = 0;
  /** Write output; false when xterm refused it (its own buffer overflowed: data was lost, every viewer is told). */
  write(data: string): boolean {
    const size = data.length;
    this.pending += size;
    try { this.terminal.write(data, () => { this.pending -= size; }); return true; }
    catch { this.pending -= size; return false; }
  }
  resize(cols: number, rows: number): void { try { this.terminal.resize(cols, rows); } catch { /* sizes are clamped before this */ } }
  /** The screen as of this call (after everything written before it), handed to `done` once parsed. */
  snapshot(done: (screen: string) => void): void {
    // At most SNAPSHOT_MAX_CHARS: a screen with a deep, colourful scrollback is sent with less of it rather than without
    // bound (the client takes one message of up to 16 MiB).
    this.terminal.write("", () => {
      let screen = "";
      for (let lines = this.lines; ; lines = Math.floor(lines / 2)) {
        try { screen = this.serializer.serialize({ scrollback: lines }); } catch { screen = ""; }
        if (screen.length <= SNAPSHOT_MAX_CHARS || lines === 0) break;
      }
      done(screen.length <= SNAPSHOT_MAX_CHARS ? screen : "");
    });
  }
  dispose(): void { try { this.terminal.dispose(); } catch { /* already */ } }
}

/** One attached page. The host never waits on it. */
export type TerminalViewer = {
  /** Account name of this viewer, for single-controller presence labels. */
  actor?: string;
  output(data: Buffer): void;
  control(message: TerminalControl): void;
  /** Bytes sent to it and not yet taken by its connection (a socket's buffered amount): the program pauses past
   * VIEWER_PAUSE_BYTES and resumes under VIEWER_RESUME_BYTES. */
  backlog?(): number;
  /** It can't be kept up to date (a holding queue or the screen mirror overflowed): close it, saying so plainly. */
  overflow?(): void;
};

/** Flow control (T4 review): the program's output is paused while any viewer has this much unsent, while the screen
 * mirror has this much unparsed, or while a page is attaching; it resumes once all are under the lower marks. */
export const VIEWER_PAUSE_BYTES = 1024 * 1024;
export const VIEWER_RESUME_BYTES = 256 * 1024;
export const MIRROR_PAUSE_CHARS = 4 * 1024 * 1024;
export const MIRROR_RESUME_CHARS = 1024 * 1024;
/** Output held for a page while its screen is prepared: past this the page is closed ("Too much output") rather than
 * the queue growing. */
export const ATTACH_HOLD_BYTES = 4 * 1024 * 1024;
/** The largest screen sent to a page that attaches (characters of the serialized screen and scrollback). */
export const SNAPSHOT_MAX_CHARS = 8 * 1024 * 1024;
export type TerminalControl =
  | { t: "hello"; cols: number; rows: number; program: TerminalProgram; ended: boolean }
  | { t: "control"; role: "controller" | "observer"; controller: string | null; viewers: string[]; epoch: number }
  | { t: "exit"; code: number | null; signal: number | null }
  /** The program isn't reading what's typed: input waits until it does. */
  | { t: "input-full" };

export type TerminalSummary = {
  id: string;
  owner: string;
  /** The owner's account generation at start: a rotated credential or a re-sign-in elsewhere no longer reaches it. */
  generation: number;
  /** Solo-workbench T4: the local-mode generation of the local owner's session that started it, or null for a full
   * session's. Only a session of the same kind and generation reaches it (a local owner never reaches a full session's
   * terminal, nor the reverse, and turning local mode off and on again leaves the old ones unreachable). */
  localGeneration: number | null;
  /** A take-over: the task and build whose saved result it opened on (Toolroll's own record of both), else null. */
  task: string | null;
  run: number | null;
  /** An agent's own sign-in or install (the Agents screen), with the agent's id: no project, no git, a fresh empty
   * folder of its own; null for every other terminal. */
  agent: { id: string; kind: "sign-in" | "install" } | null;
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
  /** A take-over's commit: its copy may be removed only while it still holds nothing but that commit. */
  base: string | null;
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
  /** What a page that attaches later is shown (ScreenMirror). */
  screen: ScreenMirror;
  /** Flow control: the program's output is paused, re-checked by this timer; pages being attached. */
  paused: boolean;
  flowTimer: NodeJS.Timeout | null;
  attaching: number;
  viewers: Set<TerminalViewer>;
  /** Single-controller lease: the viewer gate holding typing & resize authority, plus actor labels for presence. */
  controller: TerminalViewer | null;
  leaseEpoch: number;
  viewerActors: Map<TerminalViewer, string>;
  viewerGates: Map<TerminalViewer, TerminalViewer>;
  closing: Promise<void> | null;
  exited: Promise<void>;
  /**
   * An agent's own sign-in or install (credential-sensitive): its screen is never mirrored or replayed, it keeps no
   * scrollback, one page attaches once (the one that started it), what it printed before that page attached is held in
   * memory only until then, and all of it is dropped when the program ends.
   */
  sensitive: boolean;
  attachedOnce: boolean;
  early: Buffer[];
  earlyBytes: number;
  /** More than SENSITIVE_EARLY_BYTES came before the page attached: what was held is gone, and the page is told. */
  dropped: boolean;
  /** Ends a sensitive pane nobody attached to within SENSITIVE_ATTACH_MS. */
  attachTimer: NodeJS.Timeout | null;
};
/** What a sensitive pane holds for its one page before that page attaches (it attaches within a moment of the start). */
export const SENSITIVE_EARLY_BYTES = 256 * 1024;
/** A sensitive pane nobody attached to by then is ended and dropped, with whatever it printed. */
export const SENSITIVE_ATTACH_MS = 30_000;
/** At most this many agent sign-ins or installs at once (they don't count toward a person's terminals). */
export const MAX_AGENT_PANES = 1;
/** What the page that attaches hears when output was dropped before it came. */
export const DROPPED_WORDS = "\r\n[Toolroll: earlier output was dropped]\r\n";

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
  /** Lines above the screen a terminal keeps for a page that attaches later (SCREEN_SCROLLBACK_LINES). */
  scrollbackLines?: number;
  closeGraceMs?: number;
  /** How long a sensitive pane waits for its page (SENSITIVE_ATTACH_MS; tests make it short). */
  sensitiveAttachMs?: number;
  ledger?: TerminalLedger;
  /** The process table (tests stand a failing one in); null when it can't be read. */
  processes?: () => ProcessTable | null;
  /** Every folder a build may write (registered projects, Toolroll's state folder): kept out of a take-over's PATH. */
  buildWritable?: () => string[];
  /** Git for a take-over's own copy (copyAt); default the hardened runner. */
  copyGit?: (file: string, args: readonly string[], options: Parameters<typeof run>[2]) => Promise<ExecResult>;
  /** Who else works in a worktree (tests stand theirs in); default worktreeResidents. */
  residents?: (table: ProcessTable, worktreeReal: string, terminalStartedMs: number) => Set<number> | null;
};

/** A take-over copy's whole git config: Toolroll's lines and nothing else. */
export const COPY_CONFIG = "[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n\tlogallrefupdates = true\n";

/** What a take-over's shell starts with: the person's own identity, locale, shell and path, and nothing else of the
 * console's environment (its login shell reads the person's startup files from there). */
export const TAKE_OVER_ENV = ["HOME", "USER", "LOGNAME", "SHELL", "PATH", "LANG", "LC_ALL", "LC_CTYPE", "LC_MESSAGES", "TMPDIR", "TZ"] as const;
export function takeOverEnvironment(from: NodeJS.ProcessEnv, buildWritable: readonly string[] = []): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of TAKE_OVER_ENV) if (typeof from[key] === "string") env[key] = from[key];
  if (env["PATH"] !== undefined) env["PATH"] = trustedPath(env["PATH"], buildWritable);
  return env;
}

/**
 * Environment for an interactive agent take-over (`claude` / `codex`): keeps the console's coding environment (so the
 * agent's own auth/config variables carry over, as in a standalone live terminal) while still scrubbing `PATH` to
 * trusted folders outside every build-writable root.
 */
export function takeOverAgentEnvironment(from: NodeJS.ProcessEnv, buildWritable: readonly string[] = []): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...from };
  if (env["PATH"] !== undefined) env["PATH"] = trustedPath(env["PATH"], buildWritable);
  return env;
}

/**
 * PATH for a take-over's shell: only absolute folders outside every build-writable root (each registered project and
 * its worktrees, Toolroll's state folder with its build worktrees and live copies), compared both as written and as
 * their real paths, so a program a build wrote is never what the person's `git` or `npm` turns out to be. Relative and
 * empty entries (which mean the current folder) go too.
 */
export function trustedPath(path: string, buildWritable: readonly string[]): string {
  const real = (p: string): string | null => { try { return realpathSync(p); } catch { return null; } };
  const roots = buildWritable.flatMap(root => [root, real(root)]).filter((one): one is string => one !== null && one !== "");
  const inside = (p: string) => roots.some(root => p === root || p.startsWith(root.endsWith("/") ? root : `${root}/`));
  return path.split(delimiter).filter(entry => {
    if (entry === "" || !isAbsolute(entry) || entry.split("/").includes("..")) return false;
    const resolved = real(entry);
    return !inside(entry) && (resolved === null || !inside(resolved));
  }).join(delimiter);
}

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

function sanitizePrompt(prompt: string | undefined): string | null {
  if (prompt === undefined) return null;
  // eslint-disable-next-line no-control-regex
  const cleaned = prompt.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "").trim().slice(0, 1200);
  if (cleaned === "") return null;
  return cleaned.startsWith("-") ? `Task: ${cleaned}` : cleaned;
}

function defaultProgram(program: TerminalProgram, env: NodeJS.ProcessEnv, prompt?: string): { file: string; args: string[] } | null {
  if (program === "shell") {
    if (process.platform === "win32") return { file: onPath("pwsh", env) ?? onPath("powershell", env) ?? "cmd.exe", args: [] };
    const shell = env["SHELL"];
    const file = shell !== undefined && isAbsolute(shell) && existsSync(shell) ? shell : onPath("bash", env) ?? "/bin/sh";
    return { file, args: ["-l"] };
  }
  const binary = program === "antigravity" ? "agy" : program;
  const file = onPath(binary, env);
  if (file === null) return null;
  const brief = sanitizePrompt(prompt);
  if (brief === null) return { file, args: [] };
  if (program === "antigravity") return { file, args: ["-i", brief] };
  return { file, args: program === "claude" ? ["--", brief] : [brief] };
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
    const { id, owner, generation, localGeneration, task, run, agent, repo, program, branch, worktree, startedAt, endedAt, exit, endedBy, cleanup } = session;
    return { id, owner, generation, localGeneration, task, run, agent: agent === null ? null : { ...agent }, repo, program, branch, worktree, startedAt, endedAt, exit, endedBy, cleanup };
  }

  /** This person's sessions, newest first. */
  list(owner: string): TerminalSummary[] {
    return [...this.sessions.values()].filter(one => one.owner === owner).map(one => this.summary(one)).reverse();
  }

  get(id: string): TerminalSummary | null {
    const session = this.sessions.get(id);
    return session === undefined ? null : this.summary(session);
  }

  /** A person's terminals running now (agent sign-ins and installs aside: they have their own limit). */
  private running(): number {
    return [...this.sessions.values()].filter(one => one.endedAt === null && one.agent === null).length;
  }
  /** Terminals kept (agent panes aside: each is removed when it ends). */
  private kept(): number {
    return [...this.sessions.values()].filter(one => one.agent === null).length;
  }
  private startingAgents = 0;

  /**
   * Make the worktree and start the program in it. `admit` is asked again right before the program starts (after the
   * slow git work): a person whose access or project went in between starts nothing.
   *
   * `from` (solo-workbench T4, a take-over): the worktree starts at that saved result's commit instead of the project's
   * HEAD. The revision is Toolroll's own record of the build (never what a checkout says), and git must name exactly
   * that commit in this project, read through the hardened git: the build's own worktree, its `.git` and its config are
   * never used, so nothing the build wrote there decides what the person's shell runs.
   */
  async start({ name: owner, generation, localGeneration = null }: { name: string; generation: number; localGeneration?: number | null }, repoPath: string, program: TerminalProgram,
    size: { cols: number; rows: number } = { cols: 100, rows: 30 }, admit: () => string | null = () => null,
    from: { revision: string; task: string; run: number; prompt?: string } | null = null): Promise<TerminalSummary> {
    if (this.stopped) throw new TerminalError("The console is stopping.");
    if (!TERMINAL_PROGRAMS.includes(program)) throw new TerminalError("Choose Claude, Codex, Antigravity or a shell.");
    if (this.running() + this.starting >= (this.options.maxSessions ?? MAX_LIVE_TERMINALS)) throw new TerminalError(`At most ${this.options.maxSessions ?? MAX_LIVE_TERMINALS} terminals can run at once. Close one first.`);
    if (this.kept() + this.starting >= MAX_KEPT_TERMINALS) throw new TerminalError(`${MAX_KEPT_TERMINALS} terminals are kept already. Remove an ended one first.`);
    // A take-over's shell starts from a short list of the person's own settings, not the console's whole environment;
    // an interactive agent take-over keeps coding auth variables while scrubbing PATH to trusted folders.
    const roots = [this.options.worktreeRoot, ...(this.options.buildWritable?.() ?? []), ...this.moreBuildWritable.flatMap(more => more())];
    const baseEnv = from === null ? this.env() : program === "shell" ? takeOverEnvironment(this.env(), roots) : takeOverAgentEnvironment(this.env(), roots);
    const env = { ...baseEnv, TERM: "xterm-256color", COLORTERM: "truecolor" };
    const command = this.options.programs?.[program] ?? defaultProgram(program, env, from?.prompt);
    if (command === null) {
      const label = program === "claude" ? "Claude Code" : program === "codex" ? "Codex" : "Antigravity";
      const binary = program === "antigravity" ? "agy" : program;
      throw new TerminalError(`${label} isn't installed on this computer (\`${binary}\` is not on PATH).`);
    }
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
      if (from !== null && !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(from.revision)) throw new TerminalError("This build has no saved commit to open a terminal on.");
      const base = from === null ? await git(["rev-parse", "--verify", "HEAD^{commit}"])
        : await git(["--no-replace-objects", "rev-parse", "--verify", "--end-of-options", `${from.revision}^{commit}`]).catch(() => "");
      if (from !== null && base !== from.revision) throw new TerminalError("This build's saved commit isn't in the project any more, so there is nothing to open a terminal on.");
      const branch = `toolroll/live-${id.slice(0, 12)}`;
      const worktree = join(this.options.worktreeRoot, id);
      mkdirSync(this.options.worktreeRoot, { recursive: true, mode: 0o700 });
      if (from === null) await git(["worktree", "add", "-b", branch, "--", worktree, base]);
      else await this.copyAt(repo, worktree, branch, base);
      const cols = clamp(size.cols, COLS), rows = clamp(size.rows, ROWS);
      let pty: Pty;
      try {
        if (this.stopped) throw new TerminalError("The console is stopping.");
        const refused = admit();
        if (refused !== null) throw new TerminalError(refused);
        pty = this.options.spawn(command.file, command.args, { cwd: worktree, env, cols, rows });
      } catch (error) {
        // Nothing ran in it: take the worktree and branch back (a take-over's copy is Toolroll's own folder).
        if (from !== null) rmSync(worktree, { recursive: true, force: true });
        else {
          await git(["worktree", "remove", "--force", "--", worktree]).catch(() => {});
          await git(["branch", "-D", "--", branch]).catch(() => {});
        }
        throw error instanceof TerminalError ? error : new TerminalError(`The program couldn't start: ${error instanceof Error ? error.message : String(error)}`);
      }
      let resolveExited!: () => void;
      const session: Session = { id, owner, generation, localGeneration, task: from?.task ?? null, run: from?.run ?? null, agent: null, base: from === null ? null : base, repo, program, branch, worktree, startedAt: this.clock().toISOString(), endedAt: null, exit: null, endedBy: null, cleanup: null,
        pty, leader: pty.pid, tty: pty.tty, known: new Map(), exitedAt: null, worktreeReal: realpathSync(worktree), startedMs: Date.now(), residentsOnly: false, residentsSeen: new Map(), cols, rows, screen: new ScreenMirror(cols, rows, this.options.scrollbackLines), paused: false, flowTimer: null, attaching: 0, viewers: new Set(), controller: null, leaseEpoch: 0, viewerActors: new Map(), viewerGates: new Map(), closing: null,
        exited: new Promise(resolve => { resolveExited = resolve; }), sensitive: false, attachedOnce: false, early: [], earlyBytes: 0, dropped: false, attachTimer: null };
      this.sessions.set(id, session);
      this.ledger.running(id);
      reserved = false;
      this.noteCustody();
      pty.onData(data => {
        this.noteSoon();
        const chunk = Buffer.from(data, "utf8");
        // The mirror refused output (its buffer overflowed): what a page would be shown is no longer whole, so every
        // page is closed plainly and reattaches.
        if (!session.screen.write(data)) for (const viewer of session.viewers) { try { viewer.overflow?.(); } catch { /* gone */ } }
        for (const viewer of session.viewers) { try { viewer.output(chunk); } catch { /* the viewer's own close handles it */ } }
        this.flow(session);
      });
      pty.onExit(({ exitCode, signal }) => {
        // What was typed and never read can't reach it now: dropped, never written to a closed terminal.
        try { pty.dropInput?.(); } catch { /* nothing queued */ }
        session.pty = null;
        if (session.flowTimer !== null) { clearInterval(session.flowTimer); session.flowTimer = null; }
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

  /**
   * An agent's own sign-in or install for the person at this computer (the Agents screen): `command` is a trusted
   * install's real path and Toolroll's own arguments, `env` an environment built from nothing (status-probe.ts
   * statusEnvironment: the person's real HOME so the agent saves its own login, a PATH of trusted folders, no Toolroll
   * credential and no token). It runs from a fresh empty folder of its own under the terminal root (never a project, a
   * worktree or git), shown and swept like any terminal, and the folder goes when it is removed. `admit` is asked right
   * before the program starts; `exited` once it has ended (the screen's detection runs again then).
   */
  async startCommand({ name: owner, generation, localGeneration = null }: { name: string; generation: number; localGeneration?: number | null },
    agent: { id: string; kind: "sign-in" | "install" }, command: { file: string; args: readonly string[] }, env: NodeJS.ProcessEnv,
    size: { cols: number; rows: number } = { cols: 100, rows: 30 }, admit: () => string | null = () => null, exited: () => void = () => {}): Promise<TerminalSummary> {
    if (this.stopped) throw new TerminalError("The console is stopping.");
    const open = [...this.sessions.values()].filter(one => one.agent !== null).length;
    if (open + this.startingAgents >= MAX_AGENT_PANES) throw new TerminalError("A sign-in or install is already open. Finish it (or close it) first.");
    const id = randomBytes(16).toString("hex");
    this.startingAgents += 1;
    let reserved = false;
    try {
      try { this.ledger.reserve(id); reserved = true; }
      catch (error) { throw error instanceof TerminalError ? error : new TerminalError(error instanceof Error ? error.message : "No terminal can start right now."); }
      mkdirSync(this.options.worktreeRoot, { recursive: true, mode: 0o700 });
      const folder = join(this.options.worktreeRoot, `agent-${id}`);
      mkdirSync(folder, { recursive: false, mode: 0o700 });
      const cols = clamp(size.cols, COLS), rows = clamp(size.rows, ROWS);
      let pty: Pty;
      try {
        if (this.stopped) throw new TerminalError("The console is stopping.");
        const refused = admit();
        if (refused !== null) throw new TerminalError(refused);
        pty = this.options.spawn(command.file, [...command.args], { cwd: folder, env: { ...env, TERM: "xterm-256color", COLORTERM: "truecolor" }, cols, rows });
      } catch (error) {
        rmSync(folder, { recursive: true, force: true });
        throw error instanceof TerminalError ? error : new TerminalError(`The program couldn't start: ${error instanceof Error ? error.message : String(error)}`);
      }
      let resolveExited!: () => void;
      const session: Session = { id, owner, generation, localGeneration, task: null, run: null, agent: { ...agent }, base: null, repo: "", program: "shell", branch: "", worktree: folder, startedAt: this.clock().toISOString(), endedAt: null, exit: null, endedBy: null, cleanup: null,
        pty, leader: pty.pid, tty: pty.tty, known: new Map(), exitedAt: null, worktreeReal: realpathSync(folder), startedMs: Date.now(), residentsOnly: false, residentsSeen: new Map(), cols, rows, screen: new ScreenMirror(cols, rows, 0), paused: false, flowTimer: null, attaching: 0, viewers: new Set(), controller: null, leaseEpoch: 0, viewerActors: new Map(), viewerGates: new Map(), closing: null,
        exited: new Promise(resolve => { resolveExited = resolve; }), sensitive: true, attachedOnce: false, early: [], earlyBytes: 0, dropped: false, attachTimer: null };
      this.wire(session, () => { resolveExited(); try { exited(); } catch { /* the caller's own */ } });
      this.sessions.set(id, session);
      this.ledger.running(id);
      reserved = false;
      this.noteCustody();
      // Nobody attached in time: it ends, and what it printed goes with it.
      session.attachTimer = setTimeout(() => {
        session.attachTimer = null;
        if (session.attachedOnce) return;
        this.forgetScreen(session);
        void this.close(session.id, "console").then(() => this.drop(session));
      }, this.options.sensitiveAttachMs ?? SENSITIVE_ATTACH_MS);
      session.attachTimer.unref?.();
      this.options.record?.("start", this.summary(session));
      return this.summary(session);
    } finally {
      this.startingAgents -= 1;
      if (reserved) this.ledger.release(id, null);
    }
  }

  /** An agent pane, ended and swept: removed outright (nothing of it is kept, and its folder goes). */
  private drop(session: Session): void {
    if (this.sessions.get(session.id) !== session) return;
    if (session.attachTimer !== null) { clearTimeout(session.attachTimer); session.attachTimer = null; }
    this.sessions.delete(session.id);
    this.ledger.forget(session.id);
    session.viewers.clear();
    this.forgetScreen(session);
    session.screen.dispose();
    rmSync(session.worktree, { recursive: true, force: true });
    this.options.record?.("remove", this.summary(session));
  }

  /** What a sensitive pane holds now for a page not yet attached, in bytes (0 once it attached or ended). */
  heldBytes(id: string): number { return this.sessions.get(id)?.earlyBytes ?? 0; }

  /** A started session's output and exit, as every terminal has them. */
  private wire(session: Session, onExited: () => void): void {
    const pty = session.pty!;
    pty.onData(data => {
      this.noteSoon();
      const chunk = Buffer.from(data, "utf8");
      if (session.sensitive) {
        // Never mirrored: straight to its one page, or held for it (in memory, briefly) until it attaches.
        if (!session.attachedOnce) {
          if (session.earlyBytes + chunk.byteLength <= SENSITIVE_EARLY_BYTES && !session.dropped) { session.early.push(chunk); session.earlyBytes += chunk.byteLength; }
          else { session.early = []; session.earlyBytes = 0; session.dropped = true; }
        }
      } else if (!session.screen.write(data)) for (const viewer of session.viewers) { try { viewer.overflow?.(); } catch { /* gone */ } }
      for (const viewer of session.viewers) { try { viewer.output(chunk); } catch { /* the viewer's own close handles it */ } }
      this.flow(session);
    });
    pty.onExit(({ exitCode, signal }) => {
      try { pty.dropInput?.(); } catch { /* nothing queued */ }
      session.pty = null;
      if (session.flowTimer !== null) { clearInterval(session.flowTimer); session.flowTimer = null; }
      session.exitedAt = Date.now();
      session.endedAt = this.clock().toISOString();
      session.exit = { code: exitCode ?? null, signal: signal || null };
      for (const viewer of session.viewers) { try { viewer.control({ t: "exit", code: session.exit.code, signal: session.exit.signal }); } catch { /* gone */ } }
      this.options.record?.("exit", this.summary(session));
      if (session.sensitive) this.forgetScreen(session);
      onExited();
      if (session.closing === null) session.closing = this.sweep(session);
      // An agent pane ends whole: swept, then removed.
      if (session.agent !== null) void session.closing.then(() => this.drop(session));
    });
  }

  /**
   * A take-over's folder (T4): an independent repository of Toolroll's own at `revision`, never a worktree of the
   * project. A worktree's git folder lives in the project's shared `.git`, where a build can plant hooks and config that
   * the person's shell prompt (`git status`) would then run outside the fence. This one's `.git` is made here, from an
   * empty template (no hooks folder, no info), with a config of Toolroll's few lines and no alternates: the recorded
   * commit is fetched into its own object store from Toolroll's record of the project (recordedCommonDir, proven from
   * disk, never a pointer a build wrote), `--depth 1`, with every object checked (fetch.fsckObjects; index-pack hashes
   * each one), so a loose object a build rewrote under a valid name is refused, never checked out. A source that reads
   * objects from elsewhere (alternates, http-alternates) is refused before any fetch. Every git here runs hardened (no
   * system or global config, no hooks, no fsmonitor; command-line settings reach the source's upload-pack too). The
   * folder is in the console's state folder, which no build may write. Throws a TerminalError when it can't be made.
   */
  private async copyAt(repo: string, folder: string, branch: string, revision: string): Promise<void> {
    let source: string;
    try { source = realpathSync(recordedCommonDir(repo)); } catch { throw new TerminalError("Toolroll couldn't read this project's own git folder, so it won't open a copy of the build."); }
    for (const borrowed of ["alternates", "http-alternates"]) {
      if (existsSync(join(source, "objects", "info", borrowed))) throw new TerminalError("This project's git reads objects from another folder (alternates), so Toolroll won't copy a build from it.");
    }
    const template = join(this.options.worktreeRoot, ".empty-template");
    mkdirSync(template, { recursive: true, mode: 0o700 });
    if (readdirSync(template).length > 0 || lstatSync(template).isSymbolicLink()) throw new TerminalError("Toolroll's terminal folder isn't as it left it.");
    const git = async (cwd: string, args: string[], refused = "Git couldn't make a copy of this build for the terminal."): Promise<ExecResult> => {
      const result = await (this.options.copyGit ?? run)("git", [...TEARDOWN_FLAGS, ...args], { cwd, envAllowlist: ENV_ALLOWLIST, env: { ...ENV }, timeoutMs: 300_000, maxBuffer: 16 * 1024 * 1024 });
      if (result.code !== 0) throw new TerminalError(refused);
      return result;
    };
    mkdirSync(folder, { recursive: false, mode: 0o700 });
    try {
      await git(folder, ["init", "--quiet", `--template=${template}`, "-b", branch]);
      // Toolroll's lines only: whatever git init wrote is replaced.
      writeFileSync(join(folder, ".git", "config"), COPY_CONFIG, { mode: 0o600 });
      await git(folder, ["-c", "protocol.file.allow=always", "-c", "fetch.fsckObjects=true", "-c", "transfer.fsckObjects=true", "-c", "uploadpack.allowAnySHA1InWant=true",
        "fetch", "--quiet", "--no-tags", "--no-recurse-submodules", "--depth", "1", "--", source, revision],
        "This build's saved commit didn't copy whole (an object in the project's git isn't what its name says), so Toolroll won't open it.");
      await git(folder, ["reset", "--quiet", "--hard", revision]);
      const head = (await git(folder, ["rev-parse", "--verify", "HEAD^{commit}"])).stdout.trim();
      if (head !== revision) throw new TerminalError("The copy of this build isn't at its saved commit.");
    } catch (error) {
      rmSync(folder, { recursive: true, force: true });
      throw error instanceof TerminalError ? error : new TerminalError("Git couldn't make a copy of this build for the terminal.");
    }
  }

  /**
   * Attach a page: it gets the screen as it is now (ScreenMirror), then `hello`, then live output — what the program
   * writes meanwhile is held and sent after the screen, in order. Returns its detach.
   */
  attach(id: string, viewer: TerminalViewer): () => void {
    const session = this.sessions.get(id);
    if (session === undefined) throw new TerminalError("No such terminal.");
    if (session.sensitive) return this.attachOnce(session, viewer);
    if (session.viewers.size >= MAX_VIEWERS) throw new TerminalError(`This terminal is open in ${MAX_VIEWERS} places already. Close one of them.`);
    const held: ({ output: Buffer } | { control: TerminalControl })[] = [];
    let live = false, heldBytes = 0, attaching = true;
    // The program is paused while the screen is prepared (flow), so little is held; past ATTACH_HOLD_BYTES the page is
    // closed plainly instead of the queue growing.
    const done = () => { if (attaching) { attaching = false; session.attaching -= 1; this.flow(session); } };
    const gate: TerminalViewer = {
      output: data => {
        if (live) return viewer.output(data);
        heldBytes += data.byteLength;
        if (heldBytes > ATTACH_HOLD_BYTES) { held.length = 0; session.viewers.delete(gate); done(); viewer.overflow?.(); return; }
        held.push({ output: data });
      },
      control: message => { if (live) viewer.control(message); else held.push({ control: message }); },
      backlog: () => viewer.backlog?.() ?? 0,
      overflow: () => viewer.overflow?.(),
    };
    session.viewers.add(gate);
    session.viewerActors.set(gate, viewer.actor ?? session.owner);
    session.viewerGates.set(viewer, gate);
    if (session.controller === null) {
      session.controller = gate;
      session.leaseEpoch += 1;
    }
    session.attaching += 1;
    this.flow(session);
    session.screen.snapshot(screen => {
      done();
      if (!session.viewers.has(gate)) return;
      try {
        if (screen !== "") viewer.output(Buffer.from(screen, "utf8"));
        viewer.control({ t: "hello", cols: session.cols, rows: session.rows, program: session.program, ended: session.endedAt !== null });
        if (session.exit !== null && !held.some(one => "control" in one && one.control.t === "exit")) viewer.control({ t: "exit", code: session.exit.code, signal: session.exit.signal });
        for (const one of held) { if ("output" in one) viewer.output(one.output); else viewer.control(one.control); }
      } catch { /* the viewer's own close handles it */ }
      held.length = 0;
      live = true;
      this.broadcastControl(session);
    });
    return () => {
      session.viewers.delete(gate);
      session.viewerActors.delete(gate);
      session.viewerGates.delete(viewer);
      if (session.controller === gate) {
        session.controller = null;
        session.leaseEpoch += 1;
      }
      done();
      this.flow(session);
      this.broadcastControl(session);
    };
  }

  private broadcastControl(session: Session): void {
    const controller = session.controller === null ? null : session.viewerActors.get(session.controller) ?? session.owner;
    const viewers = [...session.viewers].map(one => session.viewerActors.get(one) ?? session.owner);
    for (const one of session.viewers) {
      try {
        one.control({
          t: "control",
          role: session.controller === one ? "controller" : "observer",
          controller,
          viewers,
          epoch: session.leaseEpoch,
        });
      } catch { /* gone */ }
    }
  }

  /** Whether this attached viewer currently holds the single-controller lease. */
  isController(id: string, viewer: TerminalViewer): boolean {
    const session = this.sessions.get(id);
    if (session === undefined) return false;
    if (session.sensitive) return session.viewers.has(viewer);
    const gate = session.viewerGates.get(viewer);
    return gate !== undefined && session.controller === gate;
  }

  /** Transfer the single-controller lease to this attached viewer and notify all observers. */
  takeControl(id: string, viewer: TerminalViewer): boolean {
    const session = this.sessions.get(id);
    if (session === undefined || session.sensitive) return false;
    const gate = session.viewerGates.get(viewer);
    if (gate === undefined || !session.viewers.has(gate)) return false;
    if (session.controller !== gate) {
      session.controller = gate;
      session.leaseEpoch += 1;
      this.broadcastControl(session);
    }
    return true;
  }

  /** Step back from controller to observer mode and notify all viewers. */
  releaseControl(id: string, viewer: TerminalViewer): void {
    const session = this.sessions.get(id);
    if (session === undefined || session.sensitive) return;
    const gate = session.viewerGates.get(viewer);
    if (gate !== undefined && session.controller === gate) {
      session.controller = null;
      session.leaseEpoch += 1;
      this.broadcastControl(session);
    }
  }

  /** Current controller actor and viewer list for presence/status displays. */
  controlState(id: string): { controller: string | null; viewers: string[]; epoch: number } | null {
    const session = this.sessions.get(id);
    if (session === undefined) return null;
    const controller = session.controller === null ? null : session.viewerActors.get(session.controller) ?? session.owner;
    const viewers = [...session.viewers].map(one => session.viewerActors.get(one) ?? session.owner);
    return { controller, viewers, epoch: session.leaseEpoch };
  }

  /** A sensitive pane's one page: what it printed so far (held in memory for this page alone), then live output; no
   * screen is ever replayed, and no second page attaches. */
  private attachOnce(session: Session, viewer: TerminalViewer): () => void {
    if (session.attachedOnce) throw new TerminalError("This sign-in is open in one place only.");
    session.attachedOnce = true;
    if (session.attachTimer !== null) { clearTimeout(session.attachTimer); session.attachTimer = null; }
    session.viewers.add(viewer);
    const early = session.early;
    session.early = [];
    session.earlyBytes = 0;
    try {
      viewer.control({ t: "hello", cols: session.cols, rows: session.rows, program: session.program, ended: session.endedAt !== null });
      if (session.dropped) viewer.output(Buffer.from(DROPPED_WORDS, "utf8"));
      for (const chunk of early) viewer.output(chunk);
      if (session.exit !== null) viewer.control({ t: "exit", code: session.exit.code, signal: session.exit.signal });
    } catch { /* the viewer's own close handles it */ }
    early.length = 0;
    this.flow(session);
    // Its one page let go (the Agents screen closed, the pane went): it can't be shown again, so it ends and goes.
    return () => {
      session.viewers.delete(viewer);
      void this.close(session.id, "owner").then(() => this.drop(session));
    };
  }

  /** A sensitive pane's ended: nothing it printed is kept (no mirror, nothing held). */
  private forgetScreen(session: Session): void {
    session.early = [];
    session.earlyBytes = 0;
    session.screen.dispose();
    session.screen = new ScreenMirror(session.cols, session.rows, 0);
  }

  /** What a page attaching now would be shown first (the screen mirror's snapshot); "" for a sensitive pane, which is
   * never replayed. */
  replay(id: string): Promise<string> {
    const session = this.sessions.get(id);
    if (session === undefined || session.sensitive) return Promise.resolve("");
    return new Promise(done => session.screen.snapshot(done));
  }

  /**
   * Flow control: pause the program's output while a page's connection is backed up, the screen mirror is behind, or a
   * page is attaching; resume once every one is under its lower mark. While paused it is checked again every 25 ms.
   */
  private flow(session: Session): void {
    const pty = session.pty;
    if (pty === null) return;
    const backlogs = [...session.viewers].map(one => { try { return one.backlog?.() ?? 0; } catch { return 0; } });
    const over = session.attaching > 0 || session.screen.pending > MIRROR_PAUSE_CHARS || backlogs.some(n => n > VIEWER_PAUSE_BYTES);
    const under = session.attaching === 0 && session.screen.pending <= MIRROR_RESUME_CHARS && backlogs.every(n => n <= VIEWER_RESUME_BYTES);
    if (over && !session.paused) {
      session.paused = true;
      try { pty.pause?.(); } catch { /* it exited between */ }
      session.flowTimer ??= setInterval(() => this.flow(session), 25);
      session.flowTimer.unref?.();
    } else if (under && session.paused) {
      session.paused = false;
      try { pty.resume?.(); } catch { /* it exited between */ }
      if (session.flowTimer !== null) { clearInterval(session.flowTimer); session.flowTimer = null; }
    }
  }

  private readonly moreBuildWritable: Array<() => readonly string[]> = [];
  /** More folders a build may write, read at each take-over's start (the console adds its projects once it has them). */
  alsoBuildWritable(roots: () => readonly string[]): void { this.moreBuildWritable.push(roots); }

  /** Whether the program's output is paused now (flow control), and how much the screen mirror has unparsed. */
  paused(id: string): boolean { return this.sessions.get(id)?.paused ?? false; }
  mirrorPending(id: string): number { return this.sessions.get(id)?.screen.pending ?? 0; }

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
    session.screen.resize(session.cols, session.rows);
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
   * terminal as its controlling terminal while the program runs, and every one noted while it ran, by pid and start
   * time (membersOf). Each signal goes only to a process still that pid and start time; a process on the terminal after
   * the program ended that was never noted, or a pid now someone else's, is never signalled and leaves the close
   * uncertain. A process that detached itself from the terminal AND its parents before it was noted is not seen — the
   * same as any terminal. Resolves when the sweep is done; never waits without bound.
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
    const pause = sleep;
    const leaderGone = () => session.pty === null;
    let readable = true;
    // Processes on its terminal after it ended that were never noted: maybe someone else's, never signalled.
    const ambiguous = new Set<number>();
    const members = (): Map<number, string> => {
      const table = this.processes();
      if (table === null) { readable = false; return new Map(); }
      const found = membersOf(table, session, ambiguous);
      for (const [pid, started] of found) session.known.set(pid, started);
      return found;
    };
    // Each signal goes only to the process it was meant for: the table is read again right before, and a pid whose
    // start time is no longer the one recorded (gone, or a pid used again) is skipped, and the close is uncertain. The
    // leader's group only while it runs: its pid is our unreaped child until the pty reports its exit, and, where the
    // table reads, still the leader that started. A table that can't be read signals the leader alone (the close is
    // uncertain then anyway).
    const signal = (found: ReadonlyMap<number, string>, name: "SIGHUP" | "SIGSTOP" | "SIGKILL") => {
      // It is being closed: typed bytes it never read are let go first, so none is written after its terminal closes.
      try { session.pty?.dropInput?.(); } catch { /* nothing queued */ }
      const table = this.processes();
      if (table === null) readable = false;
      const leaderStarted = session.known.get(session.leader);
      if (!leaderGone() && (table === null || (leaderStarted !== undefined && table.get(session.leader)?.started === leaderStarted))) {
        try { process.kill(-session.leader, name); } catch { /* gone */ }
        try { session.pty?.kill(name); } catch { /* gone */ }
      }
      if (table === null) return;
      for (const [pid, started] of found) {
        const now = table.get(pid);
        if (now === undefined) continue;
        if (now.started !== started) { ambiguous.add(pid); continue; }
        try { process.kill(pid, name); } catch { /* gone */ }
      }
    };
    let cleanup: "clean" | "uncertain" = "uncertain";
    try {
      if (process.platform === "win32") {
        try { session.pty?.dropInput?.(); } catch { /* nothing queued */ }
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
        let found = members();
        if (!readable) return;
        if (found.size === 0 && leaderGone()) { cleanup = "clean"; return; }
        // Stopped first, then read again until nothing new appears: a stopped process can't fork, so a child one started
        // just before it stopped is still its descendant here and is killed with it. Killed while running, a parent can
        // fork between the read and the kill, and its child goes to launchd unnoted.
        for (let settle = 0; settle < 5; settle += 1) {
          signal(found, "SIGSTOP");
          const again = members();
          if (!readable) return;
          const grew = [...again.keys()].some(pid => !found.has(pid));
          found = again;
          if (!grew) break;
        }
        signal(found, "SIGKILL");
        await pause(100);
      }
    } finally {
      // The leader's exit is waited for, but never without bound.
      await Promise.race([session.exited, pause(1_000)]);
      // Proven members gone is not enough to free the worktree: nothing of this user may still be working in it.
      if (cleanup === "clean") {
        const table = this.processes();
        const residents = table === null ? null : (this.options.residents ?? worktreeResidents)(table, session.worktreeReal, session.startedMs);
        if (residents === null || residents.size > 0) {
          cleanup = "uncertain";
          session.residentsOnly = residents !== null;
          // Who was there, by pid and start time: removal waits for each to exit, not merely to leave the folder.
          for (const pid of residents ?? []) { const row = table!.get(pid); if (row !== undefined) session.residentsSeen.set(pid, row.started); }
        }
      }
      session.cleanup = readable && leaderGone() && ambiguous.size === 0 ? cleanup : "uncertain";
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
    const residents = table === null ? null : (this.options.residents ?? worktreeResidents)(table, session.worktreeReal, session.startedMs);
    if (residents === null || residents.size > 0) throw busy;
    // Each process seen working in it when the sweep ended must have exited (the same pid with the same start time is
    // the same process, wherever it now works).
    if ([...session.residentsSeen].some(([pid, started]) => table!.get(pid)?.started === started)) throw busy;
    // A take-over's copy is the only place its work lives: it goes only while it holds nothing but the build's commit.
    if (session.base !== null) {
      const own = await this.copyHasWork(session.worktree, session.base);
      if (own !== null) throw new TerminalError(own);
    }
    this.sessions.delete(id);
    this.ledger.forget(id);
    for (const viewer of session.viewers) { try { viewer.control({ t: "exit", code: session.exit?.code ?? null, signal: session.exit?.signal ?? null }); } catch { /* gone */ } }
    session.viewers.clear();
    session.screen.dispose();
    if (session.base !== null || session.agent !== null) {
      rmSync(session.worktree, { recursive: true, force: true });
      this.options.record?.("remove", this.summary(session));
      return;
    }
    const result = await (this.options.git ?? teardownGit())(session.repo, ["worktree", "remove", "--force", "--", session.worktree]);
    this.options.record?.("remove", this.summary(session));
    if (result.code !== 0 && existsSync(session.worktree)) {
      const why = refusal(result);
      throw new TerminalError(`The terminal is gone, but its worktree stays${why === null ? "" : ` (${why})`}. Remove it with \`git worktree remove\`.`);
    }
  }

  /**
   * Why a take-over's copy can't be removed, naming what would be lost; null when it holds nothing but the build's
   * commit. Every ref (branches, tags, the stash), HEAD and every reflog entry is checked: any commit not reachable from
   * the recorded base is the person's own work, and so is any change not committed. Unreadable is never "nothing".
   */
  private async copyHasWork(folder: string, base: string): Promise<string | null> {
    const read = async (args: string[]) => (this.options.copyGit ?? run)("git", [...TEARDOWN_FLAGS, ...args], { cwd: folder, envAllowlist: ENV_ALLOWLIST, env: { ...ENV }, timeoutMs: 60_000, maxBuffer: 16 * 1024 * 1024 });
    const stays = (what: string) => `This copy holds ${what} that exist nowhere else, so it stays at ${folder}. Copy what you need out of it, then delete the folder.`;
    try {
      const own = await read(["rev-list", "--all", "--reflog", "--not", base, "--"]);
      const status = await read(["status", "--porcelain", "--untracked-files=all", "--ignore-submodules=all"]);
      if (own.code !== 0 || status.code !== 0) return stays("work (its git couldn't be read)");
      const commits = own.stdout.split("\n").filter(line => /^[0-9a-f]{40,64}$/.test(line));
      const lost: string[] = [];
      if (commits.length > 0) {
        const named = await read(["log", "--no-walk=unsorted", "--format=%h %s", ...commits.slice(0, 5), "--"]);
        const list = named.code === 0 ? named.stdout.trim().split("\n").map(line => line.slice(0, 80)).join("; ") : commits.slice(0, 5).map(one => one.slice(0, 12)).join(", ");
        lost.push(`${commits.length} commit${commits.length === 1 ? "" : "s"} (${list}${commits.length > 5 ? "; …" : ""})`);
      }
      if (status.stdout.trim() !== "") lost.push("changes not committed");
      return lost.length === 0 ? null : stays(lost.join(" and "));
    } catch { return stays("work (its git couldn't be read)"); }
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
 * the leader while it runs, everything whose controlling terminal is its terminal while it runs, and every descendant
 * of those. Never this console itself. Once the program has ended its terminal's name is no one's proof: the device
 * may already be someone else's, so a process on it that wasn't noted is not a member; it goes in `ambiguous` (when
 * given), and the close that meets one says it is uncertain rather than signal it.
 */
export function membersOf(table: ProcessTable, session: { leader: number; tty: string | null; known: ReadonlyMap<number, string>; exitedAt: number | null }, ambiguous?: Set<number>): Map<number, string> {
  const found = new Map<number, string>();
  const live = session.exitedAt === null;
  const onTerminal = (tty: string) => session.tty !== null && tty === session.tty;
  for (const [pid, row] of table) {
    if (pid === process.pid || pid <= 1) continue;
    const noted = session.known.get(pid);
    // The leader by pid only while it runs: after it exits its pid may be someone else's (it is noted by start time).
    if (noted === row.started || (pid === session.leader && live) || (live && onTerminal(row.tty))) found.set(pid, row.started);
  }
  for (let grew = true; grew;) {
    grew = false;
    for (const [pid, row] of table) if (!found.has(pid) && pid !== process.pid && found.has(row.ppid)) { found.set(pid, row.started); grew = true; }
  }
  if (ambiguous !== undefined && !live) for (const [pid, row] of table) if (!found.has(pid) && pid !== process.pid && pid > 1 && onTerminal(row.tty)) ambiguous.add(pid);
  return found;
}

/**
 * Each listed process's working directory (Linux: /proc; macOS: lsof), and which ones couldn't be read (a setgid
 * helper such as ssh-agent is unreadable even to its own user). Null when the lookup itself failed: a timeout, a signal
 * or partial output is never a smaller answer. A process gone in between is simply absent.
 */
export function cwdsOf(pids: readonly number[]): { cwds: Map<number, string>; unreadable: number[] } | null {
  const cwds = new Map<number, string>(), unreadable: number[] = [];
  if (pids.length === 0) return { cwds, unreadable };
  if (process.platform === "linux") {
    for (const pid of pids) {
      try { cwds.set(pid, readlinkSync(`/proc/${pid}/cwd`)); }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EACCES" || code === "EPERM") unreadable.push(pid);
        else if (code !== "ENOENT") return null;
      }
    }
    return { cwds, unreadable };
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
  return { cwds, unreadable };
}

/**
 * This user's processes working inside a terminal's worktree, whoever started them. They are never signalled (one may
 * be the person's own shell or a server they started from elsewhere); while any remains, the terminal's cleanup is
 * uncertain and its worktree stays. Null when that can't be known: the lookup failed, or a process whose working
 * directory can't be read started after the terminal did (one from before — a login's ssh-agent — can't be its own).
 */
export function worktreeResidents(table: ProcessTable, worktreeReal: string, terminalStartedMs: number = 0): Set<number> | null {
  const uid = process.getuid?.() ?? -1;
  const candidates = [...table].filter(([pid, row]) => pid !== process.pid && row.uid === uid).map(([pid]) => pid);
  const read = cwdsOf(candidates);
  if (read === null) return null;
  if (read.unreadable.some(pid => { const started = table.get(pid)?.started; return started === undefined || !(Date.parse(started) < terminalStartedMs - 1_000); })) return null;
  return new Set([...read.cwds].filter(([, cwd]) => cwd === worktreeReal || cwd.startsWith(`${worktreeReal}/`)).map(([pid]) => pid));
}

/** One client frame, read strictly; null closes the socket. */
export type TerminalInput =
  | { t: "in"; d: string }
  | { t: "resize"; cols: number; rows: number }
  | { t: "take-control" }
  | { t: "release-control" };
export const MAX_FRAME_BYTES = 64 * 1024;

export function parseTerminalFrame(text: string): TerminalInput | null {
  if (Buffer.byteLength(text) > MAX_FRAME_BYTES) return null;
  let value: unknown;
  try { value = JSON.parse(text); } catch { return null; }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const frame = value as Record<string, unknown>;
  const keys = Object.keys(frame).sort().join(",");
  if (frame["t"] === "in" && keys === "d,t" && typeof frame["d"] === "string") return { t: "in", d: frame["d"] };
  if (frame["t"] === "take-control" && keys === "t") return { t: "take-control" };
  if (frame["t"] === "release-control" && keys === "t") return { t: "release-control" };
  if (frame["t"] === "resize" && keys === "cols,rows,t") {
    const cols = frame["cols"], rows = frame["rows"];
    if (Number.isSafeInteger(cols) && Number.isSafeInteger(rows) && (cols as number) >= COLS.min && (cols as number) <= COLS.max && (rows as number) >= ROWS.min && (rows as number) <= ROWS.max) {
      return { t: "resize", cols: cols as number, rows: rows as number };
    }
  }
  return null;
}
