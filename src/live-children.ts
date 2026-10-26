/**
 * Subagents' records (docs/plans/agents-view.md §2.3): what each subagent a Claude run delegates to said and did, in
 * `live/<run>.sub.jsonl`, beside — never inside — the run's own records. The run's own file, its step ids, sequence and
 * caps are untouched: the parent recorder still drops every subagent event (stream-scope.ts).
 *
 * Routing is separate from open steps: a delegation (a Task/Agent call, the parent's own or a subagent's) maps its
 * provider call id to a child stream, and the mapping outlives the call's result, so a background subagent's late
 * first words still route. Each stream has its own recorder — its own open steps, key-block state and chunking, under
 * the run's captured "Show commands" answer — and its ids are rewritten `c<s>s<n>`, a form the parent never uses.
 * A close only ever reaches its own stream's steps. Bounded everywhere: 16 streams, 32 delegations, depth 2, 32 open
 * child steps, the file's own size cap; what doesn't fit is counted, never shown. A checkpoint (each stream's parent,
 * open steps and key state) is written when a stream opens and every 32 KiB, for a reader that starts mid-file.
 *
 * Display state, never evidence: the machine running the agent could alter the file.
 */
import { closeSync, constants, mkdirSync, openSync, writeSync } from "node:fs";
import { LIVE_SUB_FILE_CAP, liveDir, liveSubLogPath } from "./live.js";
import { createLiveRecorder, type KeyState, type LiveRecord, type LiveRecorder, type LiveRecorderOptions } from "./live-records.js";
import { primaryResultEvent, topLevelEvent } from "./stream-scope.js";

export const CHILD_STREAMS_CAP = 16;
export const CHILD_DELEGATIONS_CAP = 32;
export const CHILD_OPEN_STEPS_CAP = 32;
export const CHILD_DEPTH_CAP = 2;
/** A checkpoint at least this often, in bytes of child records. */
export const CHILD_CHECKPOINT_BYTES = 32 * 1024;

export type ChildCheckpoint = { s: number; parent: string | null; via?: number; open: string[]; inKey: boolean; tail?: string; ended?: true };
export type ChildRecord =
  | (LiveRecord & { s: number })
  | { k: "child"; s: number; at: string; parent: string | null; via?: number; desc?: string }
  | { k: "end"; s: number; at: string; ok: boolean | null }
  | { k: "over"; at: string }
  | { k: "ckpt"; at: string; streams: ChildCheckpoint[]; dropped: number };

type Stream = { s: number; depth: number; parent: string | null; via?: number; recorder: LiveRecorder; keys: KeyState; open: Set<string>; ended: boolean;
  /** The steps this stream's recorder wrote for the event in hand: provider call id → our id and its target as written. */
  noted: Map<string, { id: string; target: string | null }> };
/** A delegation: who made it, and where its subagent's events go once it speaks. */
type Delegation = { depth: number; parent: string | null; via?: number; desc: string | null; stream?: Stream; ended?: true };

const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
/** A provider call id: a plain, bounded string, or nothing — never a number or an array coerced into one. */
const callId = (value: unknown): string | null => (typeof value === "string" && value !== "" && value.length <= 200 ? value : null);
const DELEGATES = new Set(["Task", "Agent"]);
/** At most about this many bytes of one event's records reach the file; past it words and one-off steps give way to one
 * `cut`, so a checkpoint (written between events) is never far behind any position. */
export const CHILD_EVENT_WORDS_CAP = 64 * 1024;

const delegationCalls = (content: unknown): Record<string, unknown>[] =>
  Array.isArray(content) ? content.map(object).filter((block): block is Record<string, unknown> => block !== null && block["type"] === "tool_use" && DELEGATES.has(String(block["name"]))) : [];

/** The child recorder: every stream event in, the subagents' records out. Hand `parentStep` to the run's own recorder
 * (LiveRecorderOptions.onStep) so a delegation names the parent's step it really opened. Never throws. */
export function createChildRecorder(options: Omit<LiveRecorderOptions, "keyState" | "onStep">): {
  observe(event: Record<string, unknown>): ChildRecord[];
  parentStep(call: string | null, id: string, target: string | null): void;
  end(): ChildRecord[];
  checkpoint(): ChildRecord;
} {
  const clock = options.clock ?? (() => new Date());
  /** Provider call id → its delegation, or "ambiguous" once two callers have used the id (then nothing routes by it). */
  const delegations = new Map<string, Delegation | "ambiguous">();
  const streams: Stream[] = [];
  const parentNoted = new Map<string, { id: string; target: string | null }>();
  let dropped = 0;
  let overWritten = false;

  /** Register a delegation call; a repeated id (whoever repeats it) makes the id ambiguous: counted, never routed. */
  const delegate = (id: string, depth: number, noted: { id: string; target: string | null } | undefined, via?: number): void => {
    if (delegations.has(id)) { delegations.set(id, "ambiguous"); dropped += 1; return; }
    if (delegations.size >= CHILD_DELEGATIONS_CAP || depth > CHILD_DEPTH_CAP) { dropped += 1; return; }
    delegations.set(id, { depth, parent: noted?.id ?? null, ...(via === undefined ? {} : { via }), desc: noted?.target ?? null });
  };
  const checkpoint = (at: string): ChildRecord => ({ k: "ckpt", at, dropped, streams: streams.map(one => ({
    s: one.s, parent: one.parent, ...(one.via === undefined ? {} : { via: one.via }), open: [...one.open], inKey: one.keys.inKey,
    ...(one.keys.tail === undefined || one.keys.tail === "" ? {} : { tail: one.keys.tail }), ...(one.ended ? { ended: true as const } : {}),
  })) });
  /** A stream's own records: ids rewritten, open steps bounded across every stream, words bounded per event. */
  const own = (stream: Stream, records: LiveRecord[], at: string): ChildRecord[] => {
    const out: ChildRecord[] = [];
    const total = () => streams.reduce((sum, one) => sum + one.open.size, 0);
    let bytes = 0, cut = false;
    for (const record of records) {
      if (record.k === "open") continue;
      bytes += Buffer.byteLength(JSON.stringify(record), "utf8");
      // Past the event's budget, words and one-off steps give way to one `cut`; tracked steps and closes still land.
      const over = bytes > CHILD_EVENT_WORDS_CAP;
      const tracked = record.k === "done" || (record.k === "step" && record.once !== true && total() < CHILD_OPEN_STEPS_CAP);
      if (over && !tracked && record.k !== "start") { if (!cut) out.push({ k: "cut", at, s: stream.s }); cut = true; continue; }
      if (record.k === "step") {
        const id = `c${stream.s}${record.id}`;
        if (!tracked) { out.push({ ...record, id, once: true, s: stream.s }); continue; }
        stream.open.add(id);
        out.push({ ...record, id, s: stream.s });
      } else if (record.k === "done") {
        const id = `c${stream.s}${record.id}`;
        if (!stream.open.delete(id)) { dropped += 1; continue; } // never one this stream has open
        out.push({ ...record, id, s: stream.s });
      } else out.push({ ...record, s: stream.s });
    }
    return out;
  };
  const endStream = (stream: Stream, at: string, ok: boolean | null): ChildRecord[] => {
    if (stream.ended) return [];
    const records = own(stream, stream.recorder.end(), at);
    stream.ended = true;
    stream.open.clear();
    return [...records, { k: "end", s: stream.s, at, ok }];
  };
  /** The main query ended: every subagent still speaking ends, and one that never spoke never will. */
  const endAll = (at: string): ChildRecord[] => {
    for (const entry of delegations.values()) if (entry !== "ambiguous" && entry.stream === undefined) entry.ended = true;
    return streams.flatMap(stream => endStream(stream, at, null));
  };
  const open = (into: Delegation, at: string): Stream => {
    const keys: KeyState = { inKey: false };
    const noted = new Map<string, { id: string; target: string | null }>();
    const stream: Stream = { s: streams.length + 1, depth: into.depth, parent: into.parent, ...(into.via === undefined ? {} : { via: into.via }),
      recorder: createLiveRecorder({ ...options, keyState: keys, onStep: (call, id, target) => { if (call !== null) noted.set(call, { id, target }); } }),
      keys, open: new Set(), ended: false, noted };
    void at;
    streams.push(stream);
    into.stream = stream;
    return stream;
  };

  return {
    parentStep(call, id, target) {
      if (call !== null) parentNoted.set(call, { id, target });
    },
    observe(event) {
      const noted = new Map(parentNoted);
      parentNoted.clear();
      try {
        const at = clock().toISOString();
        const content = event["type"] === "assistant" ? object(event["message"])?.["content"] : undefined;
        if (topLevelEvent(event)) {
          // The parent's delegations, each named by the step the parent's recorder actually wrote for that call.
          for (const block of delegationCalls(content)) { const id = callId(block["id"]); if (id !== null) delegate(id, 1, noted.get(id)); }
          return primaryResultEvent(event) ? endAll(at) : [];
        }
        const reference = callId(event["parent_tool_use_id"]);
        const into = reference === null ? undefined : delegations.get(reference);
        if (into === undefined || into === "ambiguous" || into.ended === true) { dropped += 1; return []; } // unknown, ambiguous or over
        let stream = into.stream;
        const records: ChildRecord[] = [];
        if (stream === undefined) {
          if (streams.length >= CHILD_STREAMS_CAP) {
            dropped += 1;
            if (overWritten) return [];
            overWritten = true;
            return [{ k: "over", at }];
          }
          stream = open(into, at);
          records.push({ k: "child", s: stream.s, at, parent: stream.parent, ...(stream.via === undefined ? {} : { via: stream.via }), ...(into.desc === null ? {} : { desc: into.desc }) });
        }
        if (stream.ended) { dropped += 1; return records; } // late: counted, never re-opened
        // A delegation id seen before (here or anywhere) is refused before the subagent's recorder sees it: no step opens.
        const blocks = Array.isArray(content) ? content : [];
        const repeated = new Set(delegationCalls(blocks).map(block => callId(block["id"])).filter((id): id is string => id === null ? false : delegations.has(id)));
        let mine: Record<string, unknown> = { ...event, parent_tool_use_id: null };
        if (repeated.size > 0) {
          for (const id of repeated) { delegations.set(id, "ambiguous"); dropped += 1; }
          const kept = blocks.filter(part => { const block = object(part); return block === null || !(block["type"] === "tool_use" && repeated.has(String(block["id"]))); });
          mine = { ...mine, message: { ...object(event["message"]), content: kept } };
        }
        // A subagent's init starts its own redaction afresh, the half-seen marker included.
        if (event["type"] === "system" && event["subtype"] === "init") { stream.keys.inKey = false; stream.keys.tail = ""; }
        stream.noted.clear();
        records.push(...own(stream, stream.recorder.observe(mine), at));
        // Its own delegations nest under it, one level more, named by the steps its recorder wrote.
        for (const block of delegationCalls(object(mine["message"])?.["content"])) {
          const id = callId(block["id"]);
          const step = id === null ? undefined : stream.noted.get(id);
          if (id !== null) delegate(id, stream.depth + 1, step === undefined ? undefined : { id: `c${stream.s}${step.id}`, target: step.target }, stream.s);
        }
        if (event["type"] === "result") records.push(...endStream(stream, at, event["is_error"] === true ? false : event["is_error"] === false ? true : null));
        if (records.some(record => record.k === "child")) records.push(checkpoint(at));
        return records;
      } catch {
        return [];
      }
    },
    end() {
      try { return endAll(clock().toISOString()); } catch { return []; }
    },
    checkpoint() {
      return checkpoint(clock().toISOString());
    },
  };
}

/**
 * The subagents' file, opened the first time a subagent speaks (a run without one has none): created here (O_EXCL,
 * O_NOFOLLOW, 0600, the live directory 0700), appended to, and closed with the run. It stops at LIVE_SUB_FILE_CAP
 * with one `cap` record, reserved inside the cap. Fail-soft: no live view is ever worth a build.
 */
export function childLogWriter(root: string, runId: number): {
  /** Whether the next batch should be preceded by a checkpoint (take it BEFORE the batch is recorded: its state is then
   * exactly the state at that position in the file). */
  due(): boolean;
  append(records: readonly ChildRecord[], before: ChildRecord | null): void;
  close(): void;
} {
  let fd: number | null = null;
  let failed = false, capped = false;
  let written = 0, sinceCheckpoint = 0;
  const write = (line: string): boolean => {
    try { writeSync(fd!, line); written += Buffer.byteLength(line, "utf8"); return true; } catch { failed = true; return false; }
  };
  const line = (record: ChildRecord): string => {
    const text = JSON.stringify(record);
    return `${Buffer.byteLength(text, "utf8") <= 8 * 1024 ? text : JSON.stringify({ k: "cut", at: record.at, ...("s" in record ? { s: record.s } : {}) })}\n`;
  };
  const one = (record: ChildRecord): void => {
    const text = line(record);
    const capLine = line({ k: "cap", at: record.at, s: 0 } as ChildRecord);
    if (written + Buffer.byteLength(text, "utf8") + Buffer.byteLength(capLine, "utf8") > LIVE_SUB_FILE_CAP) { capped = true; write(capLine); return; }
    if (write(text)) sinceCheckpoint += Buffer.byteLength(text, "utf8");
  };
  return {
    due() {
      return fd !== null && !failed && !capped && sinceCheckpoint >= CHILD_CHECKPOINT_BYTES;
    },
    append(records, before) {
      if (records.length === 0 || failed || capped) return;
      if (fd === null) {
        try {
          mkdirSync(liveDir(root), { recursive: true, mode: 0o700 });
          fd = openSync(liveSubLogPath(root, runId), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
        } catch { failed = true; return; }
      }
      for (const record of before === null ? records : [before, ...records]) {
        if (failed || capped) return;
        if (record.k === "ckpt") sinceCheckpoint = 0;
        one(record);
      }
    },
    close() {
      if (fd !== null) try { closeSync(fd); } catch { /* already gone */ }
      fd = null;
      failed = true;
    },
  };
}
