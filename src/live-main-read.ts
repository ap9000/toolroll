/**
 * Reading a run's own live file for the Agents view's tiles (docs/plans/agents-view.md §2.3, N1): through the checked
 * opener, one bounded window per request, from a sealed cursor — or, with none, from the start of a small file or
 * the last 256 KiB of a large one. The run's own file has no checkpoints (its format is unchanged), so a read that
 * starts mid-file can't know whether it starts inside a key block: it reads as if inside one until an END marker or
 * 64 KiB of text pass, and a line that can't be read puts it back in that state. Every record is re-checked and
 * re-redacted (live-records.ts parseLiveRecord) and read under the run's own captured "Show commands" answer.
 */
import { closeSync } from "node:fs";
import { withholdCommands } from "./live.js";
import { CURSOR_CAP, openCursor, sealCursor, UNKNOWN_KEY_BYTES } from "./live-children-read.js";
import { openLiveTrusted, READ_WINDOW, readLiveLines, SCAN_BUDGET } from "./live-open.js";
import { parseLiveRecord, validKeyTail, type KeyState, type LiveRecord } from "./live-records.js";

type MainState = { run: number; gen: string; off: number; skipping: boolean; inKey: boolean; tail: string; unknown: number };

export type MainWindow =
  | { ok: true; records: LiveRecord[]; cursor: string; restarted: boolean; earlier: boolean; quarantined: number; skipped: number; more: boolean }
  | { ok: false; reason: "missing" | "unavailable" };

function unseal(cursor: string, key: Buffer, run: number, gen: string): MainState | null {
  if (cursor.length > CURSOR_CAP) return null;
  const raw = openCursor(cursor, key);
  if (raw === null || raw["run"] !== run || raw["gen"] !== gen) return null;
  const { off, skipping, inKey, tail, unknown } = raw;
  if (!Number.isSafeInteger(off) || (off as number) < 0 || typeof skipping !== "boolean" || typeof inKey !== "boolean") return null;
  if (typeof tail !== "string" || !validKeyTail(tail) || !Number.isSafeInteger(unknown) || (unknown as number) < 0 || (unknown as number) > UNKNOWN_KEY_BYTES) return null;
  return { run, gen, off: off as number, skipping, inKey, tail, unknown: unknown as number };
}

/** One window of a run's own live file. `commands` is the run's own captured answer (store.ts runLiveCommands). */
export function readMainWindow(root: string, runId: number, cursor: string | null, options: { key: Buffer; commands: boolean }): MainWindow {
  const opened = openLiveTrusted(root, `${Math.trunc(runId)}.jsonl`);
  if (opened === "missing" || opened === "unavailable") return { ok: false, reason: opened };
  try {
    let state = cursor === null ? null : unseal(cursor, options.key, runId, opened.gen);
    const restarted = cursor !== null && (state === null || state.off > opened.size);
    let earlier = false;
    if (state === null || state.off > opened.size) {
      // A small file from its start (its state is known there); a large one from its last 256 KiB, key state unknown.
      earlier = opened.size > SCAN_BUDGET;
      state = earlier
        ? { run: runId, gen: opened.gen, off: opened.size - SCAN_BUDGET, skipping: true, inKey: true, tail: "", unknown: UNKNOWN_KEY_BYTES }
        : { run: runId, gen: opened.gen, off: 0, skipping: false, inKey: false, tail: "", unknown: 0 };
    }
    const from = state.off;
    const read = readLiveLines(opened.fd, opened.size, state.off, state.skipping);
    const unknowable = () => { state!.unknown = UNKNOWN_KEY_BYTES; state!.inKey = true; };
    if (read.skipped > 0) unknowable();
    const records: LiveRecord[] = [];
    let quarantined = 0;
    for (const line of read.lines) {
      const keys: KeyState = { inKey: state.inKey || state.unknown > 0, tail: state.tail };
      const parsed = parseLiveRecord(line.text, keys);
      if (parsed === null) { quarantined += 1; unknowable(); continue; }
      if (state.unknown > 0) {
        const left = keys.inKey ? Math.max(0, state.unknown - Buffer.byteLength(line.text, "utf8")) : 0;
        state.unknown = left;
        state.inKey = left > 0;
      } else state.inKey = keys.inKey;
      state.tail = keys.tail ?? "";
      if (parsed.k === "say" && parsed.t.length === 0) continue; // all inside a key block
      records.push(...withholdCommands([parsed], options.commands));
    }
    state.off = read.next;
    state.skipping = read.skipping;
    const more = read.next < opened.size && read.next > from && (read.skipping || opened.size - from > READ_WINDOW);
    return { ok: true, records, cursor: sealCursor(state, options.key), restarted, earlier, quarantined, skipped: read.skipped, more };
  } catch {
    return { ok: false, reason: "unavailable" };
  } finally {
    closeSync(opened.fd);
  }
}
