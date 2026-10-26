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
import { createLiveRecorder, liveShort, type KeyState, type LiveRecord, type LiveRecorder, type LiveRecorderOptions } from "./live-records.js";
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

type Stream = { s: number; depth: number; parent: string | null; via?: number; recorder: LiveRecorder; keys: KeyState; open: Set<string>; ended: boolean };

const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const callId = (value: unknown): string | null => (typeof value === "string" && value !== "" && value.length <= 200 ? value : null);
const DELEGATES = new Set(["Task", "Agent"]);

/** The child recorder: every stream event in, the subagents' records out. `parentRecords` are the run's own records
 * for the same event (to name the parent's step a delegation opened). Never throws. */
export function createChildRecorder(options: Omit<LiveRecorderOptions, "keyState">): {
  observe(event: Record<string, unknown>, parentRecords: readonly LiveRecord[]): ChildRecord[];
  end(): ChildRecord[];
  checkpoint(): ChildRecord;
} {
  const clock = options.clock ?? (() => new Date());
  /** Provider call id of a delegation → where its subagent's events go (a stream once it speaks). */
  const delegations = new Map<string, { depth: number; parent: string | null; via?: number; desc: string | null; stream?: Stream }>();
  const streams: Stream[] = [];
  let dropped = 0;
  let overWritten = false;

  const delegate = (block: Record<string, unknown>, depth: number, parent: string | null, via?: number): void => {
    const id = callId(block["id"]);
    if (id === null || !DELEGATES.has(String(block["name"]))) return;
    if (delegations.has(id) || delegations.size >= CHILD_DELEGATIONS_CAP || depth > CHILD_DEPTH_CAP) { dropped += 1; return; }
    const input = object(block["input"]) ?? {};
    delegations.set(id, { depth, parent, ...(via === undefined ? {} : { via }), desc: liveShort(input["description"]) });
  };
  const checkpoint = (at: string): ChildRecord => ({ k: "ckpt", at, dropped, streams: streams.map(one => ({
    s: one.s, parent: one.parent, ...(one.via === undefined ? {} : { via: one.via }), open: [...one.open], inKey: one.keys.inKey,
    ...(one.keys.tail === undefined || one.keys.tail === "" ? {} : { tail: one.keys.tail }), ...(one.ended ? { ended: true as const } : {}),
  })) });
  /** A stream's own records, its ids rewritten and its open steps bounded across every stream. */
  const own = (stream: Stream, records: LiveRecord[]): ChildRecord[] => {
    const out: ChildRecord[] = [];
    const total = () => streams.reduce((sum, one) => sum + one.open.size, 0);
    for (const record of records) {
      if (record.k === "open") continue;
      if (record.k === "step") {
        const id = `c${stream.s}${record.id}`;
        if (record.once === true || total() >= CHILD_OPEN_STEPS_CAP) { out.push({ ...record, id, once: true, s: stream.s }); continue; }
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
    const records = own(stream, stream.recorder.end());
    stream.ended = true;
    stream.open.clear();
    return [...records, { k: "end", s: stream.s, at, ok }];
  };
  const endAll = (at: string): ChildRecord[] => streams.flatMap(stream => endStream(stream, at, null));

  return {
    observe(event, parentRecords) {
      try {
        const at = clock().toISOString();
        const content = event["type"] === "assistant" ? object(event["message"])?.["content"] : undefined;
        if (topLevelEvent(event)) {
          // The parent's delegations: the k-th tool call is the k-th step the parent recorded for this event.
          if (Array.isArray(content)) {
            const steps = parentRecords.filter(record => record.k === "step");
            let next = 0;
            for (const part of content) {
              const block = object(part);
              if (block === null || block["type"] !== "tool_use") continue;
              const known = callId(block["id"]) !== null && delegations.has(String(block["id"]));
              const step = known ? undefined : steps[next++];
              delegate(block, 1, step === undefined ? null : step.id);
            }
          }
          // The main query's result ends every subagent still speaking for this turn.
          return primaryResultEvent(event) ? endAll(at) : [];
        }
        const into = delegations.get(String(event["parent_tool_use_id"]));
        if (into === undefined) { dropped += 1; return []; }
        let stream = into.stream;
        const records: ChildRecord[] = [];
        if (stream === undefined) {
          if (streams.length >= CHILD_STREAMS_CAP) {
            dropped += 1;
            if (overWritten) return [];
            overWritten = true;
            return [{ k: "over", at }];
          }
          const keys: KeyState = { inKey: false };
          stream = { s: streams.length + 1, depth: into.depth, parent: into.parent, ...(into.via === undefined ? {} : { via: into.via }),
            recorder: createLiveRecorder({ ...options, keyState: keys }), keys, open: new Set(), ended: false };
          streams.push(stream);
          into.stream = stream;
          records.push({ k: "child", s: stream.s, at, parent: stream.parent, ...(stream.via === undefined ? {} : { via: stream.via }), ...(into.desc === null ? {} : { desc: into.desc }) });
        }
        if (stream.ended) { dropped += 1; return records; } // late: counted, never re-opened
        const own_ = { ...event, parent_tool_use_id: null };
        const theirs = own(stream, stream.recorder.observe(own_));
        records.push(...theirs);
        // A subagent's own delegations nest under it, one level more.
        if (Array.isArray(content)) {
          const steps = theirs.filter(record => record.k === "step");
          let next = 0;
          for (const part of content) {
            const block = object(part);
            if (block === null || block["type"] !== "tool_use") continue;
            const step = steps[next++];
            delegate(block, stream.depth + 1, step === undefined ? null : String(step.id), stream.s);
          }
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
export function childLogWriter(root: string, runId: number): { append(records: readonly ChildRecord[], checkpoint: () => ChildRecord): void; close(): void } {
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
    append(records, checkpoint) {
      if (records.length === 0 || failed || capped) return;
      if (fd === null) {
        try {
          mkdirSync(liveDir(root), { recursive: true, mode: 0o700 });
          fd = openSync(liveSubLogPath(root, runId), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
        } catch { failed = true; return; }
      }
      for (const record of records) {
        if (failed || capped) return;
        one(record);
        if (record.k === "ckpt") sinceCheckpoint = 0;
      }
      if (!failed && !capped && sinceCheckpoint >= CHILD_CHECKPOINT_BYTES) { one(checkpoint()); sinceCheckpoint = 0; }
    },
    close() {
      if (fd !== null) try { closeSync(fd); } catch { /* already gone */ }
      fd = null;
      failed = true;
    },
  };
}
