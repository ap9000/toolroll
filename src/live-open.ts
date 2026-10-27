/**
 * Opening and reading a live file for the Agents view (docs/plans/agents-view.md §3, N4, N5): one opener and one
 * bounded line reader, shared by every reader and observer that slice adds.
 *
 * The opener. Node has no openat, so a file can't be opened relative to a held directory; instead the open is checked
 * on both sides. Before: the live directory is a real directory (not a link), owned by this process's user, writable
 * by no one else, and it resolves inside the data root. The file is opened O_NOFOLLOW | O_NONBLOCK (a link or a FIFO
 * never blocks or redirects), and its descriptor must be a plain file with exactly one link, this user's, on the
 * directory's device. After: the directory path still names the same directory, and the file path still names the
 * very file opened. Anything else is "unavailable" — never a guess, never another file's contents or timing.
 *
 * The reader. One request reads at most READ_WINDOW bytes and looks at most SCAN_BUDGET past its start for a line's
 * end: a longer line is skipped and said so, and the scan resumes past it on the next request rather than blocking
 * this one. An unfinished last line stays pending.
 */
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, type BigIntStats } from "node:fs";
import { join, sep } from "node:path";
import { liveDir } from "./live.js";

export const READ_WINDOW = 64 * 1024;
export const SCAN_BUDGET = 256 * 1024;

export type LiveOpened = { fd: number; gen: string; size: number };
type Identity = { dev: bigint; ino: bigint };
const same = (a: Identity, b: Identity) => a.dev === b.dev && a.ino === b.ino;
const uid = () => (typeof process.getuid === "function" ? BigInt(process.getuid()) : null);

/** Test seams only: run between the checks, to swap things under the opener. */
export type OpenSeams = { afterOpen?: () => void };

/** Open `name` in the run's live directory under `root`, or say it is missing or unavailable. */
export function openLiveTrusted(root: string, name: string, seams: OpenSeams = {}): LiveOpened | "missing" | "unavailable" {
  if (!/^\d{1,15}\.(?:jsonl|sub\.jsonl)$/.test(name)) return "unavailable";
  const dir = liveDir(root);
  let before: BigIntStats;
  try {
    before = lstatSync(dir, { bigint: true });
    const real = realpathSync(dir), base = realpathSync(root);
    if (!before.isDirectory() || before.isSymbolicLink() || (before.mode & 0o022n) !== 0n || !real.startsWith(base + sep)) return "unavailable";
    const me = uid();
    if (me !== null && before.uid !== me) return "unavailable";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unavailable";
  }
  const path = join(dir, name);
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unavailable"; }
  try {
    seams.afterOpen?.();
    const file = fstatSync(fd, { bigint: true });
    const me = uid();
    if (!file.isFile() || file.nlink !== 1n || file.dev !== before.dev || (me !== null && file.uid !== me)) throw new Error("not ours");
    if (!same(lstatSync(dir, { bigint: true }), before) || !same(lstatSync(path, { bigint: true }), file)) throw new Error("moved");
    return { fd, gen: `${file.dev}:${file.ino}:${file.birthtimeNs}`, size: Number(file.size) };
  } catch {
    try { closeSync(fd); } catch { /* already */ }
    return "unavailable";
  }
}

export type LineRead = {
  /** Complete lines, each with the offset just past its newline. */
  lines: { text: string; end: number }[];
  /** Where the next request starts. */
  next: number;
  /** Lines too long to show that were skipped here. */
  skipped: number;
  /** The scan budget ran out inside a line: the next request resumes discarding through that line's end. */
  skipping: boolean;
};

/** Read complete lines from `from` (discarding first through the next newline when `skipping`), within the budgets. */
export function readLiveLines(fd: number, size: number, from: number, skipping = false): LineRead {
  const out: LineRead = { lines: [], next: from, skipped: 0, skipping: false };
  if (from >= size) return { ...out, skipping };
  const want = Math.min(size - from, READ_WINDOW);
  const buffer = Buffer.alloc(want);
  let got = 0;
  while (got < want) { const n = readSync(fd, buffer, got, want - got, from + got); if (n <= 0) break; got += n; }
  let at = 0;
  if (skipping) {
    const lf = buffer.subarray(0, got).indexOf(0x0a);
    if (lf === -1) return { ...out, next: from + got, skipping: true };
    at = lf + 1;
  }
  for (;;) {
    const lf = buffer.subarray(at, got).indexOf(0x0a);
    if (lf === -1) break;
    out.lines.push({ text: buffer.subarray(at, at + lf).toString("utf8"), end: from + at + lf + 1 });
    at += lf + 1;
  }
  out.next = from + at;
  // Nothing whole in a full window: one line longer than the window. Look on, within the budget, for its end.
  if (out.lines.length === 0 && !skipping && got === READ_WINDOW) {
    const scan = Buffer.alloc(16 * 1024);
    for (let pos = from + got; pos < Math.min(size, from + SCAN_BUDGET); ) {
      const n = readSync(fd, scan, 0, Math.min(scan.length, from + SCAN_BUDGET - pos, size - pos), pos);
      if (n <= 0) break;
      const lf = scan.subarray(0, n).indexOf(0x0a);
      if (lf !== -1) return { ...out, next: pos + lf + 1, skipped: 1 };
      pos += n;
    }
    // Past the budget (or the end so far) still inside it: resume discarding there next time.
    const stop = Math.min(size, from + SCAN_BUDGET);
    return { ...out, next: stop, skipped: 1, skipping: true };
  }
  return out;
}
