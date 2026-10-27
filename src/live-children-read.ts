/**
 * Reading a run's subagents' file (docs/plans/agents-view.md §2.3, N1): forward from a sealed cursor, or — on a first
 * read or a cursor that doesn't hold — from the newest checkpoint near the end, and never from a guess.
 *
 * The file is display state the machine running the agent could alter, so the reader trusts nothing it reads back:
 * every record is re-checked (shape, caps, its stream open, a close only of its own stream's open step), re-redacted
 * under that stream's own key state, and read under the run's captured "Show commands" answer (never the file's).
 * What fails is quarantined: counted, never shown, never promoted to the run's own conversation.
 *
 * The cursor carries the state the next window needs — offset, file generation, each stream's parent, open steps and
 * key state — bounded (17 streams, 32 open steps, 4 KiB encoded), bound to this run and file, and sealed with an HMAC
 * under a key the caller keeps outside any build's reach. A valid cursor is state, never permission: the caller proves
 * access on every read. One that doesn't verify, or names another run or file, restarts visibly.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { closeSync, readSync } from "node:fs";
import { withholdCommands } from "./live.js";
import { openLiveTrusted, READ_WINDOW, readLiveLines, SCAN_BUDGET } from "./live-open.js";
import { parseLiveRecord, redactLiveLines, validKeyTail, type KeyState, type LiveRecord } from "./live-records.js";
import { CHILD_OPEN_STEPS_CAP, CHILD_STREAMS_CAP } from "./live-children.js";

export const CURSOR_CAP = 4 * 1024;
/** Longer than any real key block: past this much of a stream's text with no END marker, its key state is known again. */
export const UNKNOWN_KEY_BYTES = 64 * 1024;
const RECORD_CAP = 8 * 1024;

/** `inKey`: a key block this reader saw open (it stays until a valid END, nothing else ends it). `unknown`: bytes of
 * this stream's text still read as if inside a block because its state can't be known (a mid-file start, a line that
 * couldn't be read): it runs down only by text actually scanned, and an END marker ends it too. */
type StreamState = { s: number; parent: string | null; via?: number; open: string[]; inKey: boolean; tail: string; ended: boolean; unknown: number };
type ReadState = { run: number; gen: string; off: number; skipping: boolean; awaiting: boolean; streams: StreamState[] };

export type ChildView =
  | { k: "child"; s: number; at?: string; parent: string | null; via?: number; desc?: string }
  | { k: "end"; s: number; at?: string; ok: boolean | null }
  | { k: "over" }
  /** The file stopped at its size cap: nothing more will be written. */
  | { k: "cap" }
  | (LiveRecord & { s: number });

export type ChildWindow =
  | {
    ok: true;
    records: ChildView[];
    cursor: string;
    /** A cursor was given but didn't hold (forged, stale, another run's or file's): this read started over. */
    restarted: boolean;
    /** Output before this read's start isn't shown (the read began at a checkpoint, or waits for one). */
    earlier: boolean;
    /** Records that failed a check: counted, never shown. */
    quarantined: number;
    /** Lines too long to show that were skipped. */
    skipped: number;
    /** More is already written: read again. */
    more: boolean;
  }
  | { ok: false; reason: "missing" | "unavailable" };

const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const streamNo = (value: unknown): number | null => (Number.isInteger(value) && (value as number) >= 1 && (value as number) <= CHILD_STREAMS_CAP ? value as number : null);
const PARENT = /^(?:s|c(?:[1-9]|1[0-6])s)[1-9][0-9]{0,8}$/;
const childStep = (s: number) => new RegExp(`^c${s}(s[1-9][0-9]{0,8})$`);

/** A stream list (from a checkpoint or a cursor) within every bound, or null. */
function streamsOf(value: unknown): StreamState[] | null {
  if (!Array.isArray(value) || value.length > CHILD_STREAMS_CAP) return null;
  const out: StreamState[] = [];
  let open = 0;
  for (const raw of value) {
    const one = object(raw);
    const s = streamNo(one?.["s"]);
    if (one === null || s === null || out.some(prior => prior.s === s)) return null;
    const parent = one["parent"], via = one["via"], ids = one["open"], tail = one["tail"] ?? "";
    if (!(parent === null || (typeof parent === "string" && PARENT.test(parent)))) return null;
    // A subagent nests under one listed before it: no cycles, nothing dangling.
    if (via !== undefined && (streamNo(via) === null || !out.some(prior => prior.s === via))) return null;
    if (!Array.isArray(ids) || !ids.every(id => typeof id === "string" && childStep(s).test(id)) || new Set(ids).size !== ids.length) return null;
    if (typeof one["inKey"] !== "boolean" || typeof tail !== "string" || !validKeyTail(tail)) return null;
    // Absent means the default; an explicit null (or anything else) is not a value these fields take.
    const ended = one["ended"] === undefined ? false : one["ended"], unknown = one["unknown"] === undefined ? 0 : one["unknown"];
    if (typeof ended !== "boolean" || !Number.isSafeInteger(unknown) || (unknown as number) < 0 || (unknown as number) > UNKNOWN_KEY_BYTES) return null;
    open += ids.length;
    out.push({ s, parent: parent as string | null, ...(via === undefined ? {} : { via: via as number }), open: ids as string[], inKey: one["inKey"] as boolean, tail, ended, unknown: unknown as number });
  }
  return open <= CHILD_OPEN_STEPS_CAP ? out : null;
}

/** Seal a reader's state under the caller's key (the same form for the run's own file and its subagents'). */
export function sealCursor(state: object, key: Buffer): string {
  const body = Buffer.from(JSON.stringify(state), "utf8").toString("base64url");
  return `${body}.${createHmac("sha256", key).update(body).digest("base64url")}`;
}

/** A sealed state's object when the seal holds and it is within the cap; null otherwise (the caller re-checks it). */
export function openCursor(cursor: string, key: Buffer): Record<string, unknown> | null {
  if (cursor.length > CURSOR_CAP) return null;
  const [body, mac, extra] = cursor.split(".");
  if (body === undefined || mac === undefined || extra !== undefined) return null;
  const want = createHmac("sha256", key).update(body).digest();
  const given = Buffer.from(mac, "base64url");
  if (given.length !== want.length || !timingSafeEqual(given, want)) return null;
  try { return object(JSON.parse(Buffer.from(body, "base64url").toString("utf8"))); } catch { return null; }
}

const seal = (state: ReadState, key: Buffer): string => sealCursor(state, key);

function unseal(cursor: string, key: Buffer, run: number, gen: string): ReadState | null {
  try {
    const raw = openCursor(cursor, key);
    const streams = streamsOf(raw?.["streams"]);
    if (raw === null || streams === null || raw["run"] !== run || raw["gen"] !== gen) return null;
    const off = raw["off"];
    if (!Number.isSafeInteger(off) || (off as number) < 0 || typeof raw["skipping"] !== "boolean" || typeof raw["awaiting"] !== "boolean") return null;
    return { run, gen, off: off as number, skipping: raw["skipping"] as boolean, awaiting: raw["awaiting"] as boolean, streams };
  } catch {
    return null;
  }
}

/** Where a read with no usable cursor begins: the file's start when it is small, else the newest checkpoint in its last
 * SCAN_BUDGET bytes; with none there, nothing is shown until the next checkpoint (fails closed). */
function bootstrap(fd: number, size: number, run: number, gen: string): { state: ReadState; earlier: boolean } {
  const empty: ReadState = { run, gen, off: 0, skipping: false, awaiting: false, streams: [] };
  if (size <= SCAN_BUDGET) return { state: empty, earlier: false };
  const from = size - SCAN_BUDGET;
  const buffer = Buffer.alloc(SCAN_BUDGET);
  let got = 0;
  while (got < buffer.length) { const n = readSync(fd, buffer, got, buffer.length - got, from + got); if (n <= 0) break; got += n; }
  const first = buffer.indexOf(0x0a);
  let found = -1;
  for (let at = first + 1; at > 0 && at < got;) {
    const lf = buffer.indexOf(0x0a, at);
    if (lf === -1) break;
    if (buffer.subarray(at, lf).indexOf('"k":"ckpt"') !== -1) {
      // A checkpoint this reader can use: one record, within the record cap, whose streams pass every bound.
      try {
        const record = lf - at <= RECORD_CAP ? object(JSON.parse(buffer.subarray(at, lf).toString("utf8"))) : null;
        if (record?.["k"] === "ckpt" && streamsOf(record["streams"]) !== null) found = at;
      } catch { /* not one */ }
    }
    at = lf + 1;
  }
  return found === -1
    ? { state: { ...empty, off: from, skipping: true, awaiting: true }, earlier: true }
    : { state: { ...empty, off: from + found, awaiting: true }, earlier: true };
}

/** One line under the state: what it shows, or null when it is quarantined (`counted` says whether it counts). */
/** A record's own time, when it is a plain ISO time (display only). */
const stampOf = (record: Record<string, unknown>): { at?: string } => {
  const at = record["at"];
  return typeof at === "string" && at.length <= 40 && Number.isFinite(Date.parse(at)) ? { at } : {};
};

/** The bytes of text a record carries (its words or its output): what uncertainty about a key block runs down by. */
function scannedText(record: Record<string, unknown>): number {
  const lines = record["k"] === "say" ? record["t"] : record["k"] === "done" ? record["out"] : undefined;
  return Array.isArray(lines) ? lines.reduce((sum: number, line) => sum + (typeof line === "string" ? Buffer.byteLength(line, "utf8") : 0), 0) : 0;
}

/** A line that couldn't be read may have carried a key marker for any stream: every stream's key state is unknown. */
function unknowable(state: ReadState): void {
  for (const one of state.streams) one.unknown = UNKNOWN_KEY_BYTES;
}

function apply(state: ReadState, text: string, commands: boolean): ChildView[] | null {
  if (Buffer.byteLength(text, "utf8") > RECORD_CAP) { unknowable(state); return null; }
  let record: Record<string, unknown> | null;
  try { record = object(JSON.parse(text)); } catch { unknowable(state); return null; }
  if (record === null) return null;
  if (record["k"] === "ckpt") {
    const streams = streamsOf(record["streams"]);
    // A checkpoint names every stream this reader already follows: one that drops a stream would let its number (and
    // its open key block) be reused.
    if (streams === null || !state.streams.every(known => streams.some(next => next.s === known.s))) return null;
    // The file's own word on key state never weakens what this reader knows: a stream it has followed keeps its own
    // key state (the checkpoint can only add caution); one it first learns of here starts unknown.
    state.streams = streams.map(next => {
      const known = state.streams.find(one => one.s === next.s);
      return known === undefined
        ? { ...next, inKey: false, tail: "", unknown: UNKNOWN_KEY_BYTES }
        : { ...next, inKey: known.inKey, tail: known.tail, unknown: next.inKey ? Math.max(known.unknown, UNKNOWN_KEY_BYTES) : known.unknown };
    });
    state.awaiting = false;
    return [];
  }
  if (state.awaiting) return [];
  if (record["k"] === "over") return [{ k: "over" }];
  if (record["k"] === "cap") return [{ k: "cap" }];
  const s = streamNo(record["s"]);
  if (s === null) return null;
  if (record["k"] === "child") {
    const parent = record["parent"], via = record["via"], desc = record["desc"];
    if (state.streams.some(one => one.s === s) || state.streams.length >= CHILD_STREAMS_CAP) return null;
    if (!(parent === null || (typeof parent === "string" && PARENT.test(parent)))) return null;
    if (via !== undefined && !state.streams.some(one => one.s === via)) return null;
    if (desc !== undefined && (typeof desc !== "string" || desc.length > 200)) return null;
    state.streams.push({ s, parent: parent as string | null, ...(via === undefined ? {} : { via: via as number }), open: [], inKey: false, tail: "", ended: false, unknown: 0 });
    const shown = typeof desc === "string" ? redactLiveLines([desc])[0] : undefined;
    return [{ k: "child", s, ...stampOf(record), parent: parent as string | null, ...(via === undefined ? {} : { via: via as number }), ...(shown === undefined ? {} : { desc: shown }) }];
  }
  const stream = state.streams.find(one => one.s === s);
  if (stream === undefined || stream.ended) return null;
  if (record["k"] === "end") {
    const ok = record["ok"];
    if (!(ok === true || ok === false || ok === null)) return null;
    stream.ended = true;
    stream.open = [];
    return [{ k: "end", s, ...stampOf(record), ok }];
  }
  // The run's own record shape, under this stream's key state, with its id as the run's own recorder writes it.
  const id = record["id"];
  let local: string | undefined;
  if (id !== undefined) {
    const match = typeof id === "string" ? childStep(s).exec(id) : null;
    if (match === null) return null;
    local = match[1];
  }
  const { s: _s, ...rest } = record;
  const body = JSON.stringify(local === undefined ? rest : { ...rest, id: local });
  // Read on a copy of the key state; it is kept only if the record passes every check below.
  const keys: KeyState = { inKey: stream.inKey || stream.unknown > 0, tail: stream.tail };
  const parsed = parseLiveRecord(body, keys);
  // The block as actually observed (not forced by uncertainty): the same record read under the observed state.
  const observed: KeyState = { inKey: stream.inKey, tail: stream.tail };
  parseLiveRecord(body, observed);
  if (parsed === null || parsed.k === "open") return null;
  if (parsed.k === "step" && parsed.once !== true) {
    const total = state.streams.reduce((sum, one) => sum + one.open.length, 0);
    if (total >= CHILD_OPEN_STEPS_CAP || stream.open.includes(id as string)) return null; // full, or already open
    stream.open.push(id as string);
  } else if (parsed.k === "done") {
    const at = stream.open.indexOf(id as string);
    if (at === -1) return null; // never one this stream has open
    stream.open.splice(at, 1);
  }
  // An observed block ends only at a valid END; uncertainty also runs down by the text this record actually carried.
  stream.inKey = keys.inKey ? observed.inKey : false;
  stream.unknown = keys.inKey ? Math.max(0, stream.unknown - scannedText(record)) : 0;
  stream.tail = keys.tail ?? "";
  if (parsed.k === "say" && parsed.t.length === 0) return []; // all inside a key block: nothing to show
  const [shown] = withholdCommands([parsed], commands);
  return [{ ...shown!, ...(local === undefined ? {} : { id: id as string }), s } as ChildView];
}

/** One window of a run's subagents' file. `commands` is the run's own captured answer (store.ts runLiveCommands). */
export function readChildWindow(root: string, runId: number, cursor: string | null, options: { key: Buffer; commands: boolean }): ChildWindow {
  const name = `${Math.trunc(runId)}.sub.jsonl`;
  const opened = openLiveTrusted(root, name);
  if (opened === "missing" || opened === "unavailable") return { ok: false, reason: opened };
  try {
    let state = cursor === null ? null : unseal(cursor, options.key, runId, opened.gen);
    let earlier = false;
    const restarted = cursor !== null && (state === null || state.off > opened.size);
    if (state === null || state.off > opened.size) {
      ({ state, earlier } = bootstrap(opened.fd, opened.size, runId, opened.gen));
      // One request's reading budget: a bootstrap that scanned the end of the file reads nothing more now.
      if (earlier) return { ok: true, records: [], cursor: seal(state, options.key), restarted, earlier, quarantined: 0, skipped: 0, more: true };
    } else earlier = state.awaiting;
    const from = state.off;
    const read = readLiveLines(opened.fd, opened.size, state.off, state.skipping);
    if (read.skipped > 0) unknowable(state);
    const records: ChildView[] = [];
    let quarantined = 0;
    for (const line of read.lines) {
      const shown = apply(state, line.text, options.commands);
      if (shown === null) quarantined += 1;
      else records.push(...shown);
    }
    state.off = read.next;
    state.skipping = read.skipping;
    // More only when this read stopped short of what is written and moved: an unfinished last line waits for growth.
    const more = read.next < opened.size && (read.next > from) && (read.skipping || opened.size - from > READ_WINDOW);
    return { ok: true, records, cursor: seal(state, options.key), restarted, earlier: earlier || state.awaiting, quarantined, skipped: read.skipped, more };
  } catch {
    return { ok: false, reason: "unavailable" };
  } finally {
    closeSync(opened.fd);
  }
}
