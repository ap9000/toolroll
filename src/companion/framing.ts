/**
 * Bounded RPC-over-Noise binary framing, multi-chunk reassembly, flow control,
 * and strict concurrency / memory limits (`docs/plans/companion-app/noise-relay-protocol.md` §3).
 *
 * Frame layout (fits inside one <= 65,519 B Noise transport plaintext):
 *   [1B frameType][4B streamId (u32 BE)][4B seq (u32 BE)][4B payloadLen (u32 BE)][payload (<= 60,000 B)]
 */

import { MAX_NOISE_PLAINTEXT_BYTES } from "./noise.js";

export const FRAME_HEADER_BYTES = 13;
export const MAX_FRAME_PAYLOAD_BYTES = 60_000;
export const MAX_LOGICAL_REQUEST_BYTES = 256 * 1024; // 256 KiB
export const MAX_REQUEST_CHUNKS = 5;
export const MAX_LOGICAL_UNARY_RESPONSE_BYTES = 1024 * 1024; // 1 MiB
export const INITIAL_STREAM_CREDIT = 16;
export const MAX_CONCURRENT_STREAMS = 8;
export const MAX_CONCURRENT_WATCH_STREAMS = 2;
export const MAX_LIVE_WATCH_RECORDS = 32;
export const MAX_LIVE_WATCH_BYTES = 256 * 1024; // 256 KiB
export const MAX_SESSION_BUFFERED_BYTES = 1024 * 1024; // 1 MiB per phone
export const MAX_DAEMON_BUFFERED_BYTES = 4 * 1024 * 1024; // 4 MiB daemon-wide
export const REQUEST_ASSEMBLY_DEADLINE_MS = 5_000;
export const UNARY_RESPONSE_DEADLINE_MS = 30_000;
export const WATCH_IDLE_DEADLINE_MS = 60_000;

export const FrameType = {
  REQ: 0x01,
  RES: 0x02,
  CHUNK: 0x03,
  CREDIT: 0x04,
  CANCEL: 0x05,
  PING: 0x06,
  PONG: 0x07,
  END: 0x08,
  ERROR: 0x09,
  REQ_CHUNK: 0x0a,
} as const;

export type FrameTypeCode = (typeof FrameType)[keyof typeof FrameType];

const VALID_FRAME_TYPES = new Set<number>(Object.values(FrameType));

export interface CompanionFrame {
  type: FrameTypeCode;
  streamId: number;
  seq: number;
  payload: Buffer;
}

export function encodeFrame(frame: CompanionFrame): Buffer {
  if (!VALID_FRAME_TYPES.has(frame.type)) {
    throw new Error(`Unknown frame type: 0x${frame.type.toString(16)}`);
  }
  if (!Number.isInteger(frame.streamId) || frame.streamId < 0 || frame.streamId > 0xffff_ffff) {
    throw new Error(`Invalid streamId: ${frame.streamId}`);
  }
  if (!Number.isInteger(frame.seq) || frame.seq < 0 || frame.seq > 0xffff_ffff) {
    throw new Error(`Invalid seq: ${frame.seq}`);
  }
  if (frame.payload.length > MAX_FRAME_PAYLOAD_BYTES) {
    throw new Error(`Frame payload ${frame.payload.length} exceeds cap ${MAX_FRAME_PAYLOAD_BYTES}`);
  }
  const total = FRAME_HEADER_BYTES + frame.payload.length;
  if (total > MAX_NOISE_PLAINTEXT_BYTES) {
    throw new Error(`Encoded frame ${total} exceeds Noise plaintext cap ${MAX_NOISE_PLAINTEXT_BYTES}`);
  }
  const out = Buffer.allocUnsafe(total);
  out.writeUInt8(frame.type, 0);
  out.writeUInt32BE(frame.streamId, 1);
  out.writeUInt32BE(frame.seq, 5);
  out.writeUInt32BE(frame.payload.length, 9);
  frame.payload.copy(out, FRAME_HEADER_BYTES);
  return out;
}

export function decodeFrame(raw: Buffer): CompanionFrame {
  if (raw.length < FRAME_HEADER_BYTES) {
    throw new Error(`Frame truncated: ${raw.length} bytes`);
  }
  if (raw.length > MAX_NOISE_PLAINTEXT_BYTES) {
    throw new Error(`Frame exceeds Noise plaintext cap: ${raw.length} bytes`);
  }
  const type = raw.readUInt8(0);
  if (!VALID_FRAME_TYPES.has(type)) {
    throw new Error(`Unknown frame type: 0x${type.toString(16)}`);
  }
  const streamId = raw.readUInt32BE(1);
  const seq = raw.readUInt32BE(5);
  const payloadLen = raw.readUInt32BE(9);
  if (payloadLen > MAX_FRAME_PAYLOAD_BYTES) {
    throw new Error(`Frame payloadLen ${payloadLen} exceeds cap ${MAX_FRAME_PAYLOAD_BYTES}`);
  }
  if (raw.length !== FRAME_HEADER_BYTES + payloadLen) {
    throw new Error(`Frame length mismatch: header declares ${payloadLen}, got ${raw.length - FRAME_HEADER_BYTES}`);
  }
  return {
    type: type as FrameTypeCode,
    streamId,
    seq,
    payload: Buffer.from(raw.subarray(FRAME_HEADER_BYTES)),
  };
}

/** Split a logical request payload (<= 256 KiB) into 1 `REQ` frame or `REQ_CHUNK` + `END` frames. */
export function splitRequestFrames(streamId: number, payload: Buffer): CompanionFrame[] {
  if (payload.length > MAX_LOGICAL_REQUEST_BYTES) {
    throw new Error(`Logical request ${payload.length} exceeds cap ${MAX_LOGICAL_REQUEST_BYTES}`);
  }
  if (payload.length <= MAX_FRAME_PAYLOAD_BYTES) {
    return [{ type: FrameType.REQ, streamId, seq: 0, payload }];
  }
  const frames: CompanionFrame[] = [];
  let seq = 0;
  for (let offset = 0; offset < payload.length; offset += MAX_FRAME_PAYLOAD_BYTES) {
    frames.push({
      type: FrameType.REQ_CHUNK,
      streamId,
      seq,
      payload: payload.subarray(offset, Math.min(offset + MAX_FRAME_PAYLOAD_BYTES, payload.length)),
    });
    seq += 1;
  }
  if (frames.length > MAX_REQUEST_CHUNKS) {
    throw new Error(`Request chunk count ${frames.length} exceeds cap ${MAX_REQUEST_CHUNKS}`);
  }
  frames.push({ type: FrameType.END, streamId, seq, payload: Buffer.alloc(0) });
  return frames;
}

/** Split a logical unary response payload (<= 1 MiB) into 1 `RES` frame or `CHUNK` + `END` frames. */
export function splitUnaryResponseFrames(streamId: number, payload: Buffer): CompanionFrame[] {
  if (payload.length > MAX_LOGICAL_UNARY_RESPONSE_BYTES) {
    throw new Error(`Logical unary response ${payload.length} exceeds cap ${MAX_LOGICAL_UNARY_RESPONSE_BYTES}`);
  }
  if (payload.length <= MAX_FRAME_PAYLOAD_BYTES) {
    return [{ type: FrameType.RES, streamId, seq: 0, payload }];
  }
  const frames: CompanionFrame[] = [];
  let seq = 0;
  for (let offset = 0; offset < payload.length; offset += MAX_FRAME_PAYLOAD_BYTES) {
    frames.push({
      type: FrameType.CHUNK,
      streamId,
      seq,
      payload: payload.subarray(offset, Math.min(offset + MAX_FRAME_PAYLOAD_BYTES, payload.length)),
    });
    seq += 1;
  }
  frames.push({ type: FrameType.END, streamId, seq, payload: Buffer.alloc(0) });
  return frames;
}

export function encodeCreditPayload(grant: number): Buffer {
  if (!Number.isInteger(grant) || grant < 1 || grant > 1024) {
    throw new Error(`Invalid credit grant: ${grant}`);
  }
  const buf = Buffer.allocUnsafe(4);
  buf.writeUInt32BE(grant, 0);
  return buf;
}

export function decodeCreditPayload(payload: Buffer): number {
  if (payload.length !== 4) throw new Error(`Invalid CREDIT payload length: ${payload.length}`);
  const grant = payload.readUInt32BE(0);
  if (grant < 1 || grant > 1024) throw new Error(`Invalid CREDIT grant: ${grant}`);
  return grant;
}

export function encodeErrorPayload(code: string, message: string): Buffer {
  return Buffer.from(JSON.stringify({ code, message }), "utf8");
}

/** Tracks daemon-wide buffered bytes across all connected phone sessions (4 MiB hard cap). */
export class GlobalBufferBudget {
  private usedBytes = 0;
  readonly limitBytes: number;

  constructor(limitBytes = MAX_DAEMON_BUFFERED_BYTES) {
    this.limitBytes = limitBytes;
  }

  get used(): number {
    return this.usedBytes;
  }

  tryReserve(bytes: number): boolean {
    if (bytes < 0) return false;
    if (this.usedBytes + bytes > this.limitBytes) return false;
    this.usedBytes += bytes;
    return true;
  }

  release(bytes: number): void {
    this.usedBytes = Math.max(0, this.usedBytes - bytes);
  }
}

interface PendingRequestAssembly {
  chunks: Buffer[];
  totalBytes: number;
  expectedSeq: number;
  startedAtMs: number;
}

export interface StreamGuardResult {
  ok: true;
  completePayload?: Buffer;
}

export interface StreamGuardError {
  ok: false;
  code:
    | "protocol_error"
    | "too_many_streams"
    | "payload_too_large"
    | "deadline_exceeded"
    | "memory_limit";
  message: string;
  closeSession?: boolean;
}

/**
 * Per-session stream admission, monotonic odd streamId enforcement (no reuse),
 * multi-chunk request reassembly, and session/global byte accounting.
 */
export class CompanionStreamGuard {
  private highestClientStreamId = 0;
  private readonly openUnaryStreams = new Set<number>();
  private readonly openWatchStreams = new Set<number>();
  private readonly assemblies = new Map<number, PendingRequestAssembly>();
  /** Bytes a unary response holds until it has all gone out (charged like request bytes). */
  private readonly responseBytes = new Map<number, number>();
  private sessionBufferedBytes = 0;
  private readonly globalBudget: GlobalBufferBudget;

  constructor(globalBudget: GlobalBufferBudget = new GlobalBufferBudget()) {
    this.globalBudget = globalBudget;
  }

  get openStreamCount(): number {
    return this.openUnaryStreams.size + this.openWatchStreams.size;
  }

  get watchStreamCount(): number {
    return this.openWatchStreams.size;
  }

  get bufferedBytes(): number {
    return this.sessionBufferedBytes;
  }

  private reserveBytes(bytes: number): boolean {
    if (this.sessionBufferedBytes + bytes > MAX_SESSION_BUFFERED_BYTES) return false;
    if (!this.globalBudget.tryReserve(bytes)) return false;
    this.sessionBufferedBytes += bytes;
    return true;
  }

  private releaseBytes(bytes: number): void {
    if (bytes <= 0) return;
    this.sessionBufferedBytes = Math.max(0, this.sessionBufferedBytes - bytes);
    this.globalBudget.release(bytes);
  }

  /** Admit a new client-initiated streamId: must be strictly monotonic odd uint32 (never reused). */
  private admitNewStream(streamId: number): StreamGuardResult | StreamGuardError {
    if (streamId === 0 || streamId % 2 !== 1 || streamId <= this.highestClientStreamId) {
      return {
        ok: false,
        code: "protocol_error",
        message: `Stream ID ${streamId} violates monotonic odd non-reuse rule (highest=${this.highestClientStreamId})`,
        closeSession: true,
      };
    }
    if (this.openStreamCount >= MAX_CONCURRENT_STREAMS) {
      return {
        ok: false,
        code: "too_many_streams",
        message: `Exceeded max ${MAX_CONCURRENT_STREAMS} concurrent streams`,
      };
    }
    this.highestClientStreamId = streamId;
    this.openUnaryStreams.add(streamId);
    return { ok: true };
  }

  /** Promote an admitted unary stream to a live watch subscription (enforces max 2 watch streams). */
  promoteToWatchStream(streamId: number): StreamGuardResult | StreamGuardError {
    if (!this.openUnaryStreams.has(streamId)) {
      return { ok: false, code: "protocol_error", message: `Stream ${streamId} is not open` };
    }
    if (this.openWatchStreams.size >= MAX_CONCURRENT_WATCH_STREAMS) {
      this.closeStream(streamId);
      return {
        ok: false,
        code: "too_many_streams",
        message: `Exceeded max ${MAX_CONCURRENT_WATCH_STREAMS} concurrent live watch streams`,
      };
    }
    this.openUnaryStreams.delete(streamId);
    this.openWatchStreams.add(streamId);
    return { ok: true };
  }

  /** Charge a unary response's bytes to this phone's and the daemon's budgets until the stream closes. */
  reserveResponse(streamId: number, bytes: number): boolean {
    if (!this.reserveBytes(bytes)) return false;
    this.responseBytes.set(streamId, (this.responseBytes.get(streamId) ?? 0) + bytes);
    return true;
  }

  /** Streams whose request has been half-sent for longer than the assembly deadline (they're closed here). */
  expireAssemblies(nowMs = Date.now()): number[] {
    const expired: number[] = [];
    for (const [streamId, asm] of this.assemblies) {
      if (nowMs - asm.startedAtMs > REQUEST_ASSEMBLY_DEADLINE_MS) expired.push(streamId);
    }
    for (const streamId of expired) this.closeStream(streamId);
    return expired;
  }

  closeStream(streamId: number): void {
    const asm = this.assemblies.get(streamId);
    if (asm !== undefined) {
      this.releaseBytes(asm.totalBytes);
      this.assemblies.delete(streamId);
    }
    const held = this.responseBytes.get(streamId);
    if (held !== undefined) {
      this.releaseBytes(held);
      this.responseBytes.delete(streamId);
    }
    this.openUnaryStreams.delete(streamId);
    this.openWatchStreams.delete(streamId);
  }

  releaseAll(): void {
    for (const asm of this.assemblies.values()) {
      this.releaseBytes(asm.totalBytes);
    }
    this.assemblies.clear();
    for (const held of this.responseBytes.values()) this.releaseBytes(held);
    this.responseBytes.clear();
    this.openUnaryStreams.clear();
    this.openWatchStreams.clear();
  }

  /** Process an inbound `REQ`, `REQ_CHUNK`, or `END` frame for request assembly. */
  ingestRequestFrame(frame: CompanionFrame, nowMs = Date.now()): StreamGuardResult | StreamGuardError {
    if (frame.type === FrameType.REQ) {
      if (frame.seq !== 0) {
        return { ok: false, code: "protocol_error", message: "REQ frame must have seq=0", closeSession: true };
      }
      const admitted = this.admitNewStream(frame.streamId);
      if (!admitted.ok) return admitted;
      return { ok: true, completePayload: frame.payload };
    }

    if (frame.type === FrameType.REQ_CHUNK) {
      let asm = this.assemblies.get(frame.streamId);
      if (asm === undefined) {
        if (frame.seq !== 0) {
          return { ok: false, code: "protocol_error", message: "First REQ_CHUNK must have seq=0", closeSession: true };
        }
        const admitted = this.admitNewStream(frame.streamId);
        if (!admitted.ok) return admitted;
        asm = { chunks: [], totalBytes: 0, expectedSeq: 0, startedAtMs: nowMs };
        this.assemblies.set(frame.streamId, asm);
      }
      if (nowMs - asm.startedAtMs > REQUEST_ASSEMBLY_DEADLINE_MS) {
        this.closeStream(frame.streamId);
        return { ok: false, code: "deadline_exceeded", message: "Multi-chunk request assembly exceeded 5s deadline" };
      }
      if (frame.seq !== asm.expectedSeq) {
        this.closeStream(frame.streamId);
        return { ok: false, code: "protocol_error", message: `Out-of-order REQ_CHUNK seq=${frame.seq}`, closeSession: true };
      }
      if (asm.chunks.length + 1 > MAX_REQUEST_CHUNKS || asm.totalBytes + frame.payload.length > MAX_LOGICAL_REQUEST_BYTES) {
        this.closeStream(frame.streamId);
        return { ok: false, code: "payload_too_large", message: "Multi-chunk request exceeded 256 KiB / 5 chunk cap" };
      }
      if (!this.reserveBytes(frame.payload.length)) {
        this.closeStream(frame.streamId);
        return { ok: false, code: "memory_limit", message: "Buffer memory limit reached" };
      }
      asm.chunks.push(frame.payload);
      asm.totalBytes += frame.payload.length;
      asm.expectedSeq += 1;
      return { ok: true };
    }

    if (frame.type === FrameType.END) {
      const asm = this.assemblies.get(frame.streamId);
      if (asm === undefined) {
        return { ok: false, code: "protocol_error", message: `Unexpected END for stream ${frame.streamId}` };
      }
      if (nowMs - asm.startedAtMs > REQUEST_ASSEMBLY_DEADLINE_MS) {
        this.closeStream(frame.streamId);
        return { ok: false, code: "deadline_exceeded", message: "Multi-chunk request assembly exceeded 5s deadline" };
      }
      if (frame.seq !== asm.expectedSeq) {
        this.closeStream(frame.streamId);
        return { ok: false, code: "protocol_error", message: `Out-of-order END seq=${frame.seq}`, closeSession: true };
      }
      const completePayload = Buffer.concat(asm.chunks, asm.totalBytes);
      this.releaseBytes(asm.totalBytes);
      this.assemblies.delete(frame.streamId);
      return { ok: true, completePayload };
    }

    return { ok: false, code: "protocol_error", message: `Unexpected frame type 0x${frame.type.toString(16)} in request ingest` };
  }
}

/**
 * Bounded live-watch record buffer: coalesces/truncates older records with `{ k: "cut" }`
 * when credit hits 0 and enforces 32-record / 256 KiB per-stream plus session/global caps.
 *
 * NOTE: Used ONLY for live watch subscriptions (`run.watch.subscribe`). Unary multi-part
 * responses NEVER drop chunks — they pause and wait for `CREDIT` via `UnaryResponsePacer`.
 */
export class LiveWatchBuffer {
  private readonly records: Buffer[] = [];
  private usedBytes = 0;
  private droppedCount = 0;
  credit: number = INITIAL_STREAM_CREDIT;

  push(record: Buffer): { accepted: boolean; cutCount: number } {
    if (record.length > MAX_FRAME_PAYLOAD_BYTES) {
      // Too big for one frame: dropped, and the phone is told there's a gap like any other cut.
      this.droppedCount += 1;
      return { accepted: false, cutCount: this.droppedCount };
    }
    while (
      this.records.length > 0
      && (this.records.length >= MAX_LIVE_WATCH_RECORDS || this.usedBytes + record.length > MAX_LIVE_WATCH_BYTES)
    ) {
      const oldest = this.records.shift()!;
      this.usedBytes -= oldest.length;
      this.droppedCount += 1;
    }
    if (this.usedBytes + record.length > MAX_LIVE_WATCH_BYTES) {
      this.droppedCount += 1;
      return { accepted: false, cutCount: this.droppedCount };
    }
    this.records.push(record);
    this.usedBytes += record.length;
    return { accepted: true, cutCount: this.droppedCount };
  }

  grantCredit(n: number): void {
    this.credit = Math.min(1024, this.credit + n);
  }

  drainAvailable(): Buffer[] {
    const out: Buffer[] = [];
    if (this.droppedCount > 0 && this.credit > 0) {
      out.push(Buffer.from(JSON.stringify({ k: "cut", dropped: this.droppedCount }), "utf8"));
      this.droppedCount = 0;
      this.credit -= 1;
    }
    while (this.credit > 0 && this.records.length > 0) {
      const next = this.records.shift()!;
      this.usedBytes -= next.length;
      this.credit -= 1;
      out.push(next);
    }
    return out;
  }

  get bufferedBytes(): number {
    return this.usedBytes;
  }

  /** Records dropped and not yet reported to the phone (a `cut` marker is still owed). */
  get pendingCut(): number {
    return this.droppedCount;
  }

  get length(): number {
    return this.records.length;
  }
}

/**
 * Unary multi-part response pacer: NEVER drops or coalesces chunks.
 * Pauses emission when credit == 0 and waits for `CREDIT` up to `UNARY_RESPONSE_DEADLINE_MS` (30s).
 */
export class UnaryResponsePacer {
  private readonly frames: CompanionFrame[];
  private cursor = 0;
  credit: number = INITIAL_STREAM_CREDIT;
  readonly startedAtMs: number;

  constructor(streamId: number, payload: Buffer, nowMs = Date.now()) {
    this.frames = splitUnaryResponseFrames(streamId, payload);
    this.startedAtMs = nowMs;
  }

  get done(): boolean {
    return this.cursor >= this.frames.length;
  }

  isTimedOut(nowMs = Date.now()): boolean {
    return !this.done && nowMs - this.startedAtMs > UNARY_RESPONSE_DEADLINE_MS;
  }

  grantCredit(n: number): void {
    this.credit = Math.min(1024, this.credit + n);
  }

  /** Pull next frames allowed by credit (`RES` and `END` do not consume chunk credit). */
  pullAvailable(nowMs = Date.now()): { ok: true; frames: CompanionFrame[] } | { ok: false; code: "deadline_exceeded" } {
    if (this.isTimedOut(nowMs)) {
      return { ok: false, code: "deadline_exceeded" };
    }
    const out: CompanionFrame[] = [];
    while (this.cursor < this.frames.length) {
      const next = this.frames[this.cursor]!;
      if (next.type === FrameType.CHUNK) {
        if (this.credit <= 0) break;
        this.credit -= 1;
      }
      out.push(next);
      this.cursor += 1;
    }
    return { ok: true, frames: out };
  }
}
