/**
 * The running build's steering mailbox (v120). A note an operator files
 * while a build runs used to wait for the next attempt; now the builder's
 * pulse writes it into one nonce-named folder in the worktree, as a numbered
 * file the agent reads and acknowledges by moving it into `handled/` — the
 * same small contract a person's own inbox keeps:
 *
 * - The durable record is the delivery. A note is mailed (written into the
 *   folder) and read (moved by the agent); nothing else counts. A hook
 *   reminding the agent, or a file the pulse wrote, proves nothing.
 * - Numbers are never reused: the next one is past every name in the folder
 *   and in `handled/`, and past every one this pulse has used.
 * - Whatever is still unread when the attempt ends keeps today's road: the
 *   note stays pending, the next attempt's brief quotes it, and a task that
 *   ends first supersedes it.
 *
 * Every step is bookkeeping, and bookkeeping never fails a build: a folder
 * the agent removed is made again, one it replaced with anything but a real
 * directory is never written through, and an error waits for the next beat.
 */
import { lstatSync, mkdirSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fence } from "./brief-fence.js";
import type { Store } from "./store.js";

export const STEER_HANDLED = "handled";
const NOTE_NAME = /^(\d+)\.json$/;

export type SteerMailbox = {
  runId: number;
  taskRef: number;
  /** Worktree-relative, as the brief names it. */
  folder: string;
  dir: string;
  /** The highest number this pulse has written. */
  last: number;
  /** Mailed and not yet moved to handled/: number → note id. */
  waiting: Map<number, number>;
};

export const steerNoteName = (number: number): string => `${String(number).padStart(3, "0")}.json`;

const isRealDirectory = (path: string): boolean => {
  try { return lstatSync(path).isDirectory(); } catch { return false; }
};

/** Make the folder and its handled/ inside the worktree; null when it cannot be made. */
export function openSteerMailbox(worktree: string, folder: string, runId: number, taskRef: number): SteerMailbox | null {
  const box: SteerMailbox = { runId, taskRef, folder, dir: join(worktree, folder), last: 0, waiting: new Map() };
  return ensureFolder(box) ? box : null;
}

function ensureFolder(box: SteerMailbox): boolean {
  for (const path of [box.dir, join(box.dir, STEER_HANDLED)]) {
    try {
      mkdirSync(path, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") return false;
    }
    // Something the agent put in the folder's place is never written through.
    if (!isRealDirectory(path)) return false;
  }
  return true;
}

function highestNumber(box: SteerMailbox): number {
  let highest = box.last;
  for (const path of [box.dir, join(box.dir, STEER_HANDLED)]) {
    let names: string[];
    try { names = readdirSync(path); } catch { continue; }
    for (const name of names) {
      const number = NOTE_NAME.exec(name)?.[1];
      if (number !== undefined) highest = Math.max(highest, Number(number));
    }
  }
  return highest;
}

/** Every waiting note the agent moved into handled/ is read, by this run. */
function collectAcknowledgements(store: Store, box: SteerMailbox, now: Date): void {
  if (box.waiting.size === 0) return;
  const handled = join(box.dir, STEER_HANDLED);
  if (!isRealDirectory(box.dir) || !isRealDirectory(handled)) return;
  for (const [number, noteId] of [...box.waiting]) {
    let moved: boolean;
    try { moved = lstatSync(join(handled, steerNoteName(number))).isFile(); } catch { moved = false; }
    if (!moved) continue;
    box.waiting.delete(number);
    store.ackSteerNote(noteId, box.runId, now);
  }
}

/** Write each note this run has not seen yet: a temp name, then the number. */
function mailNotes(store: Store, box: SteerMailbox, now: Date): void {
  const notes = store.mailableSteerNotes(box.taskRef, box.runId);
  if (notes.length === 0 || !ensureFolder(box)) return;
  for (const note of notes) {
    const number = highestNumber(box) + 1;
    const name = steerNoteName(number);
    const temp = join(box.dir, `.${name}.tmp`);
    const body = { version: 1, number, filedAt: note.createdAt, note: fence(note.note) };
    try {
      writeFileSync(temp, `${JSON.stringify(body, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      renameSync(temp, join(box.dir, name));
    } catch {
      try { unlinkSync(temp); } catch { /* never written */ }
      return;
    }
    box.last = number;
    let recorded: boolean;
    try { recorded = store.markSteerMailed(note.id, box.runId, now); } catch { recorded = false; }
    if (recorded) {
      box.waiting.set(number, note.id);
    } else {
      // The task ended or the note settled between the read and the write, or
      // the mailing could not be recorded: an unrecorded file would only be
      // mailed twice, so it goes, and the next beat tries again.
      try { unlinkSync(join(box.dir, name)); } catch { /* the agent already took it */ }
    }
  }
}

/** One beat: record what the agent read, then mail what is new while the agent runs. */
export function pulseSteerMailbox(store: Store, box: SteerMailbox, now: Date, agentRunning: boolean): void {
  collectAcknowledgements(store, box, now);
  if (agentRunning) mailNotes(store, box, now);
}

/** The attempt is over: one last read, then the folder goes. Unread notes stay pending for the next attempt. */
export function closeSteerMailbox(store: Store, box: SteerMailbox, now: Date): void {
  try { collectAcknowledgements(store, box, now); } catch { /* the notes stay pending */ }
  try { rmSync(box.dir, { recursive: true, force: true }); } catch { /* the next attempt's sweep removes it */ }
}

const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

/**
 * Claude's doorbell: a synchronous PostToolUse hook that lists the folder and,
 * while a note is unread, hands the agent one line of context between tool
 * calls. It only says notes are waiting — it never quotes one, and its firing
 * is never an acknowledgement. Rendered into the run's own --settings.
 */
export function claudeSteerHooks(dir: string, folder: string): { PostToolUse: { matcher: string; hooks: { type: "command"; command: string }[] }[] } {
  const context = {
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: `Operator steering waiting: %s unread note(s) in ${folder}/. Read them in number order now, act on each within the agreed scope, then move each into ${folder}/${STEER_HANDLED}/.`,
    },
  };
  const command = `set -- ${shellQuote(dir)}/[0-9]*.json; [ -e "$1" ] || exit 0; printf ${shellQuote(`${JSON.stringify(context)}\n`)} "$#"`;
  return { PostToolUse: [{ matcher: "*", hooks: [{ type: "command", command }] }] };
}
