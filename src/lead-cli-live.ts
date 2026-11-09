/**
 * The terminal's live reply for `toolroll chat` (docs/plans/responsive-chat.md §3.6): on a TTY only, one status line
 * shown at once and redrawn in place, then the answer as it is written, in a block of at most six rows wrapped to the
 * terminal's width by display width (wide and combining characters). Piped output and `--json` never get here.
 *
 * Only this renderer emits cursor controls. Every piece of model-derived text it draws (the partial reply, and the
 * status line, which can carry a tool's label) passes through `terminalText` first, on the whole accumulated text
 * every time, so an escape sequence split across stream chunks can never get past it.
 *
 * Views come from the shared live-reply core and are drawn through its serialized sender, so `finish()` resolves only
 * after the last draw: the block is erased and the caller prints the final answer (or the failure) strictly after.
 * The erase moves up within the block's known height; a terminal that scrolled meanwhile keeps what it showed.
 * Every draw first re-proves the caller's `standing`: once it fails, the block is erased and nothing more is drawn.
 */
import type { LeadProgress } from "./lead-progress.js";
import { createLiveReply, createLiveSender } from "./live-reply.js";
import { renderReply, type ShapeOptions } from "./reply-shape.js";
import { terminalText } from "./terminal-text.js";

/** Where the live block is drawn: the terminal, or a test's recording. */
export type TerminalLiveOutput = {
  write(chunk: string): void;
  /** The terminal's width now, in columns; undefined when unknown. */
  columns(): number | undefined;
  /** Call the listener when the terminal is resized; returns the unsubscribe. */
  onResize(listener: () => void): () => void;
  /** Call the listener on Ctrl-C during a turn (the process then exits, as Ctrl-C always did); returns the unsubscribe. */
  onInterrupt(listener: () => void): () => void;
  /** Draw the status line dimmed (off under NO_COLOR). */
  dim?: boolean;
};

/** At most this many rows of the reply show under the status line. */
export const LIVE_TERMINAL_ROWS = 6;
/** The least time between two redraws. */
const REDRAW_MS = 50;
const STOPPED = "Stopped.";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** East Asian wide and fullwidth ranges: these take two columns. */
const WIDE: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f], [0x231a, 0x231b], [0x2329, 0x232a], [0x23e9, 0x23ec], [0x23f0, 0x23f0], [0x23f3, 0x23f3],
  [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xa960, 0xa97f],
  [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe10, 0xfe19], [0xfe30, 0xfe6f], [0xff00, 0xff60], [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f], [0x1f900, 0x1f9ff], [0x20000, 0x2fffd], [0x30000, 0x3fffd],
];

/** The columns one grapheme takes: 0 for a lone combining or format mark, 2 for wide and emoji, else 1. */
export function graphemeWidth(cluster: string): number {
  if (cluster === "") return 0;
  if (/\p{Regional_Indicator}/u.test(cluster)) return 2;
  if (/\p{Extended_Pictographic}/u.test(cluster) && (cluster.includes("️") || /\p{Emoji_Presentation}/u.test(cluster))) return 2;
  if (/^[\p{Mn}\p{Me}\p{Cf}]/u.test(cluster)) return 0;
  const point = cluster.codePointAt(0)!;
  return WIDE.some(([low, high]) => point >= low && point <= high) ? 2 : 1;
}

/** The columns a line of text takes on a terminal. */
export function displayWidth(text: string): number {
  let width = 0;
  for (const { segment } of graphemes.segment(text)) width += graphemeWidth(segment);
  return width;
}

/** One line cut to fit `width` columns, ending in "…" when it was cut. */
function fitRow(text: string, width: number): string {
  if (displayWidth(text) <= width) return text;
  let shown = "";
  let used = 0;
  for (const { segment } of graphemes.segment(text)) {
    const next = graphemeWidth(segment);
    if (used + next > width - 1) break;
    shown += segment;
    used += next;
  }
  return `${shown}…`;
}

/** Text wrapped to rows of at most `width` columns: at the last space where there is one, else mid-word. */
export function wrapRows(text: string, width: number): string[] {
  const rows: string[] = [];
  for (const line of text.split("\n")) {
    let row: string[] = [];
    let used = 0;
    let space = -1;
    for (const { segment } of graphemes.segment(line)) {
      const next = graphemeWidth(segment);
      if (used + next > width && row.length > 0) {
        // A space that doesn't fit ends the row there; it is not carried to the next one.
        if (segment === " ") {
          rows.push(row.join("").trimEnd());
          row = [];
          used = 0;
          space = -1;
          continue;
        }
        while (used + next > width && row.length > 0) {
          if (space > 0) {
            rows.push(row.slice(0, space).join("").trimEnd());
            row = row.slice(space + 1);
          } else {
            rows.push(row.join(""));
            row = [];
          }
          used = row.reduce((sum, one) => sum + graphemeWidth(one), 0);
          space = row.lastIndexOf(" ");
        }
      }
      row.push(segment);
      used += next;
      if (segment === " ") space = row.length - 1;
    }
    rows.push(row.join("").trimEnd());
  }
  return rows;
}

export type TerminalLive = {
  /** Feed one engine event (the turn's `onProgress`). */
  progress(event: LeadProgress): void;
  /** The turn ended: wait for the last draw, then erase the block. The final answer or failure prints after this. */
  finish(): Promise<void>;
};

/**
 * Start one turn's live block: the status line shows at once. `shape` is the final reply's shaping (the owner's
 * message and this app's origins), so a partial reads as the final will.
 */
export function startTerminalLive(out: TerminalLiveOutput, shape: ShapeOptions = {}, options: {
  spacingMs?: number;
  /** Re-proved immediately before every draw (the person, the conversation, its projects and the turn, once known,
   * running under the generation it was admitted with). False: the block is erased and nothing more is drawn. */
  standing?: (turn: number | null) => boolean;
} = {}): TerminalLive {
  const reply = createLiveReply(shape);
  /** The turn this block follows, once the engine has said it started. */
  let turn: number | null = null;
  /** The rows on screen now, as drawn (without the dim styling); empty when nothing is. */
  let drawn: string[] = [];
  let ended = false;
  const columns = (): number => {
    const known = out.columns();
    return known !== undefined && Number.isFinite(known) && known > 0 ? Math.floor(known) : 80;
  };
  /** Back to the block's first row and clear to the end of the screen. Rows are measured at the width now, as a
   * terminal that reflows on resize has rewrapped them. */
  const eraseSequence = (): string => {
    if (drawn.length === 0) return "";
    const now = columns();
    const height = drawn.reduce((sum, row) => sum + Math.max(1, Math.ceil(displayWidth(row) / now)), 0);
    drawn = [];
    return `\r${height > 1 ? `\x1b[${height - 1}A` : ""}\x1b[J`;
  };
  const draw = (): void => {
    if (ended) return;
    if (options.standing !== undefined && !options.standing(turn)) {
      // Standing lost: clear what is shown and close the preview; the turn's own outcome says why.
      ended = true;
      void sender.close();
      stopResize();
      const erase = eraseSequence();
      if (erase !== "") out.write(erase);
      return;
    }
    // Three columns short of the edge: a full row never leaves the cursor waiting to wrap, and the "^C" a terminal
    // echoes after the last row on Ctrl-C never wraps it, so the erase's height stays right.
    const width = Math.max(10, columns() - 3);
    const view = reply.view();
    const status = view.phase === "working" || view.phase === "writing" ? view.status : reply.status();
    const text = view.phase === "writing" ? terminalText(renderReply(view.text, "terminal")) : "";
    const rows = [fitRow(terminalText(status), width), ...(text === "" ? [] : wrapRows(text, width).slice(-LIVE_TERMINAL_ROWS))];
    const erase = eraseSequence();
    const styled = rows.map((row, index) => (index === 0 && out.dim !== false ? `\x1b[2m${row}\x1b[22m` : row));
    out.write(`${erase}${styled.join("\n")}`);
    drawn = rows;
  };
  const sender = createLiveSender<null>({ send: draw, spacingMs: options.spacingMs ?? REDRAW_MS });
  const stopResize = out.onResize(() => sender.offer(null));
  const stopInterrupt = out.onInterrupt(() => {
    void sender.close();
    const erase = eraseSequence();
    ended = true;
    stopResize();
    out.write(`${erase}${STOPPED}\n`);
  });
  draw();
  return {
    progress(event) {
      turn ??= event.turn;
      // Model text is made terminal-safe before it is settled and shaped, on the whole text written so far.
      if (reply.push(event.kind === "text" ? { ...event, text: terminalText(event.text) } : event)) sender.offer(null);
    },
    async finish() {
      await sender.close();
      stopResize();
      stopInterrupt();
      if (ended) return;
      ended = true;
      const erase = eraseSequence();
      if (erase !== "") out.write(erase);
    },
  };
}

/** The real terminal: stdout, its resize events, and Ctrl-C (which still ends the process, after the block is gone). */
export function processTerminal(env: Record<string, string | undefined> = process.env): TerminalLiveOutput {
  return {
    write: chunk => { process.stdout.write(chunk); },
    columns: () => process.stdout.columns,
    onResize(listener) {
      process.stdout.on("resize", listener);
      return () => { process.stdout.off("resize", listener); };
    },
    onInterrupt(listener) {
      const handler = (): void => {
        process.off("SIGINT", handler);
        try { listener(); } finally { process.exit(130); }
      };
      process.on("SIGINT", handler);
      return () => { process.off("SIGINT", handler); };
    },
    dim: env["NO_COLOR"] === undefined || env["NO_COLOR"] === "",
  };
}

/** A live block only on a real terminal that can move its cursor, and never for an agent driving the CLI. */
export function liveTerminalWanted(json: boolean, env: Record<string, string | undefined>, tty: boolean, agent: () => boolean): boolean {
  return !json && tty && env["TERM"] !== "dumb" && !agent();
}
