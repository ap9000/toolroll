/**
 * `toolroll peek` — the terminal multiplexer over live agents.
 *
 * One pane per open run: its task, worker, role, stage word, elapsed
 * clock, and the tail of its live transcript (the same per-run file the
 * console's run page follows: what the agent said and each step it took —
 * a command's text only where its project shows commands, never file
 * contents, credential shapes redacted at write and again at read). Digits focus one pane, `a` shows all, `q`
 * leaves. No dependency: the screen is the alternate buffer and a
 * handful of escape sequences. `--tmux` opens a real tmux session with one
 * window per run for people who live there. Outside a TTY (or with
 * `--json`) it prints one snapshot and exits — the same data, an envelope.
 *
 * Read-only by construction: nothing here writes to the store or the
 * files; a peek is a look.
 */

import { spawn } from "node:child_process";
import { liveWindowLines, readLiveWindow } from "./live.js";
import { validKeyTail } from "./live-records.js";
import { runLiveCommands, type Store } from "./store.js";
import { sleep } from "./sleep.js";

export const PEEK_TAIL_LINES = 400;
const ESC = "\u001b";

export type PeekPane = {
  runId: number;
  taskId: string;
  title: string;
  repo: string | null;
  runner: string;
  role: string;
  provider: string;
  model: string | null;
  phase: string;
  startedAt: string;
  /** Tail of the live transcript, newest last. */
  lines: string[];
  /** Why the transcript is absent, when it is. */
  transcript: "live" | "not-yet" | "replaced" | "unreadable";
};

type Tail = { offset: number; lines: string[]; state: PeekPane["transcript"]; gen?: string; inKey?: boolean; keyTail?: string };

const REPLACED: Tail = { offset: 0, lines: ["[the live view was replaced — starting over]"], state: "replaced" };

/**
 * Advance one run's tail from its offset; `replaced` resets visibly. The
 * offset always moves by the bytes read, even when nothing in them shows. `commands` is the run's own captured
 * "Show commands" answer (store.ts runLiveCommands)
 * (a finished step, a skipped line), and an offset is only ever used
 * against the file it came from.
 */
export function advanceTail(root: string, runId: number, tail: Tail, commands: boolean): Tail {
  const read = readLiveWindow(root, runId, tail.offset);
  if (!read.ok) {
    if (read.reason === "replaced") return REPLACED;
    return { ...tail, keyTail: validKeyTail(tail.keyTail ?? "") ? tail.keyTail ?? "" : "", state: read.reason === "missing" ? (tail.lines.length === 0 ? "not-yet" : tail.state) : "unreadable" };
  }
  if (tail.gen !== undefined && tail.gen !== read.gen) return { ...REPLACED, gen: read.gen };
  const keys = { inKey: tail.inKey === true, tail: validKeyTail(tail.keyTail ?? "") ? tail.keyTail ?? "" : "" };
  const fresh = liveWindowLines(read, commands, keys);
  const lines = [...tail.lines, ...fresh].slice(-PEEK_TAIL_LINES);
  return { offset: read.nextOffset, lines, state: lines.length === 0 ? "not-yet" : "live", gen: read.gen, inKey: keys.inKey, keyTail: keys.tail };
}

/** The stage word for a pane: the machine's own phase, or what precedes it. */
export function stageWord(run: { phase: string | null; model: string | null; providerStartedAt: string | null }): string {
  if (run.phase !== null) return run.phase.replace(/-/g, " ");
  return run.providerStartedAt === null ? "preparing workspace" : "the agent is working";
}

export function elapsedWords(startedAt: string, now: Date): string {
  const ms = Math.max(0, now.getTime() - new Date(startedAt).getTime());
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m` : `${minutes}m${String(seconds).padStart(2, "0")}s`;
}

/** One snapshot of every live run — the envelope's body, and the TUI's first frame. */
export function snapshotLiveRuns(store: Store, root: string, now: Date, tails: Map<number, Tail> = new Map()): PeekPane[] {
  const panes: PeekPane[] = [];
  for (const run of store.liveRuns(now)) {
    const previous = tails.get(run.id) ?? { offset: 0, lines: [], state: "not-yet" as const };
    const tail = advanceTail(root, run.id, previous, runLiveCommands(store, run.id));
    tails.set(run.id, tail);
    panes.push({
      runId: run.id,
      taskId: run.taskId,
      title: run.title,
      repo: run.repo,
      runner: run.runner,
      role: run.role,
      provider: run.provider,
      model: run.model,
      phase: stageWord(run),
      startedAt: run.startedAt,
      lines: tail.lines,
      transcript: tail.state,
    });
  }
  for (const id of [...tails.keys()]) {
    if (!panes.some(one => one.runId === id)) tails.delete(id);
  }
  return panes;
}

// ---- the frame --------------------------------------------------------------

function fit(text: string, width: number): string {
  const chars = [...text];
  if (chars.length <= width) return text + " ".repeat(width - chars.length);
  return chars.slice(0, Math.max(0, width - 1)).join("") + "…";
}

function header(pane: PeekPane, index: number, now: Date, width: number, focused: boolean): string {
  const left = `${index + 1} · #${pane.runId} ${pane.title}`;
  const right = `${pane.runner} · ${pane.role} · ${pane.phase} · ${elapsedWords(pane.startedAt, now)}`;
  const room = Math.max(0, width - [...right].length - 1);
  const line = `${fit(left, room)} ${right}`;
  return `${ESC}[7m${focused ? `${ESC}[1m` : ""}${fit(line, width)}${ESC}[0m`;
}

/**
 * Compose one frame: panes stacked, each with a header and as many tail
 * lines as its share of the rows allows; the focused pane takes the whole
 * screen. Pure — the loop paints what this returns.
 */
export function composeFrame(panes: PeekPane[], size: { columns: number; rows: number }, focus: number | null, now: Date): string {
  const columns = Math.max(20, size.columns);
  const rows = Math.max(4, size.rows);
  const footer = `${ESC}[2m${fit(panes.length === 0 ? "no agent is working right now — q leaves" : `${panes.length} live · 1-${Math.min(9, panes.length)} focus · a all · q leaves`, columns)}${ESC}[0m`;
  const shown = focus !== null && panes[focus] !== undefined ? [panes[focus] as PeekPane] : panes;
  const out: string[] = [];
  if (shown.length === 0) {
    out.push(fit("", columns));
    out.push(fit("  nothing to peek at: no run is open.", columns));
    for (let i = out.length; i < rows - 1; i += 1) out.push(fit("", columns));
    out.push(footer);
    return out.join("\n");
  }
  const body = rows - 1;
  const share = Math.max(2, Math.floor(body / shown.length));
  for (const [i, pane] of shown.entries()) {
    const index = focus !== null && panes[focus] !== undefined ? focus : i;
    const height = i === shown.length - 1 ? body - share * (shown.length - 1) : share;
    out.push(header(pane, index, now, columns, focus !== null));
    const lines = pane.lines.length === 0
      ? [pane.transcript === "not-yet" ? "  (no transcript yet — the agent has not spoken)" : pane.transcript === "unreadable" ? "  (the live file could not be read)" : "  …"]
      : pane.lines.slice(-(height - 1)).map(one => `  ${one}`);
    for (let r = 0; r < height - 1; r += 1) out.push(fit(lines[r] ?? "", columns));
  }
  while (out.length < rows - 1) out.push(fit("", columns));
  out.push(footer);
  return out.slice(0, rows).join("\n");
}

// ---- the loop ---------------------------------------------------------------

export type PeekIo = {
  stdout: NodeJS.WriteStream & { columns?: number; rows?: number };
  stdin: NodeJS.ReadStream & { setRawMode?: (raw: boolean) => void; isRaw?: boolean };
};

/**
 * Follow live runs until `q` (or, watching one run, until it finishes).
 * Resolves with the exit code.
 */
export async function runPeek(
  store: Store,
  root: string,
  options: { runId?: number; io: PeekIo; clock?: () => Date; intervalMs?: number },
): Promise<number> {
  const { io } = options;
  const clock = options.clock ?? (() => new Date());
  const tails = new Map<number, Tail>();
  let focus: number | null = null;
  let stop = false;
  let finishedWord: string | null = null;

  const paint = (): void => {
    const now = clock();
    let panes = snapshotLiveRuns(store, root, now, tails);
    if (options.runId !== undefined) {
      panes = panes.filter(one => one.runId === options.runId);
      if (panes.length === 0 && finishedWord === null) {
        const run = store.getRun(options.runId);
        finishedWord = run === null ? "no such run" : `run #${options.runId} finished: ${run.outcome ?? "?"}${run.reason === null ? "" : ` (${run.reason})`}`;
        stop = true;
      }
    }
    const size = { columns: io.stdout.columns ?? 100, rows: io.stdout.rows ?? 30 };
    io.stdout.write(`${ESC}[H${composeFrame(panes, size, options.runId !== undefined ? null : focus, now)}`);
  };

  const wasRaw = io.stdin.isRaw === true;
  io.stdout.write(`${ESC}[?1049h${ESC}[?25l${ESC}[2J`);
  io.stdin.setRawMode?.(true);
  io.stdin.resume();
  const onKey = (chunk: Buffer): void => {
    for (const ch of chunk.toString("utf8")) {
      if (ch === "q" || ch === "\u0003") stop = true;
      else if (ch === "a") focus = null;
      else if (ch >= "1" && ch <= "9") focus = Number(ch) - 1;
    }
  };
  io.stdin.on("data", onKey);
  const onResize = (): void => paint();
  io.stdout.on("resize", onResize);

  try {
    paint();
    while (!stop) {
      await sleep(options.intervalMs ?? 500);
      paint();
    }
  } finally {
    io.stdin.removeListener("data", onKey);
    io.stdout.removeListener("resize", onResize);
    io.stdin.setRawMode?.(wasRaw);
    io.stdin.pause();
    io.stdout.write(`${ESC}[?25h${ESC}[?1049l`);
    if (finishedWord !== null) io.stdout.write(`${finishedWord}\n`);
  }
  return 0;
}

// ---- tmux -------------------------------------------------------------------

/**
 * A real tmux session, one window per live run, each running `peek <run>`
 * — for people who already live in tmux. The plane never becomes tmux's
 * dependant: liveness stays in the store's leases, and this is a view.
 */
export async function openInTmux(
  panes: readonly PeekPane[],
  command: readonly string[],
  run: (file: string, args: readonly string[]) => Promise<{ code: number; stderr: string }>,
  session = "toolroll",
): Promise<{ ok: true; windows: number } | { ok: false; message: string }> {
  if (panes.length === 0) return { ok: false, message: "no run is open — nothing to open a window for" };
  const probe = await run("tmux", ["-V"]);
  if (probe.code !== 0) return { ok: false, message: "tmux is not installed (or not on PATH) — `toolroll peek` without --tmux needs nothing" };
  const shellWord = (part: string): string => `'${part.replace(/'/g, "'\\''")}'`;
  const commandFor = (runId: number): string => [...command, "peek", String(runId)].map(shellWord).join(" ");
  const [first, ...rest] = panes;
  const made = await run("tmux", ["new-session", "-d", "-s", session, "-n", (first as PeekPane).taskId, commandFor((first as PeekPane).runId)]);
  if (made.code !== 0) return { ok: false, message: `tmux new-session: ${made.stderr.trim() || "refused"} — a session named ${session} may already exist (\`tmux attach -t ${session}\`)` };
  for (const pane of rest) {
    await run("tmux", ["new-window", "-t", session, "-n", pane.taskId, commandFor(pane.runId)]);
  }
  return { ok: true, windows: panes.length };
}

/** Hand the terminal to tmux and wait for it to come back. */
export function attachTmux(session = "toolroll"): Promise<number> {
  return new Promise(resolve => {
    const child = spawn("tmux", ["attach", "-t", session], { stdio: "inherit" });
    child.on("exit", code => resolve(code ?? 0));
    child.on("error", () => resolve(1));
  });
}
