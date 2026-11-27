/** Buffer accounting the final review asked for: response bytes are budgeted, half-sent requests expire without a next
 * frame, and a record too big for a frame is reported as a cut. */
import { expect, test } from "vitest";
import { CompanionStreamGuard, encodeFrame, FrameType, GlobalBufferBudget, LiveWatchBuffer, MAX_SESSION_BUFFERED_BYTES, REQUEST_ASSEMBLY_DEADLINE_MS, decodeFrame } from "./framing.js";

test("a unary response's bytes are charged to the phone's own budget until its stream closes", () => {
  const budget = new GlobalBufferBudget();
  const guard = new CompanionStreamGuard(budget);
  expect(guard.ingestRequestFrame({ type: FrameType.REQ, streamId: 1, seq: 0, payload: Buffer.from("{}") }).ok).toBe(true);
  expect(guard.reserveResponse(1, MAX_SESSION_BUFFERED_BYTES - 10)).toBe(true);
  expect(guard.reserveResponse(1, 100)).toBe(false); // the phone's 1 MiB is spoken for
  expect(budget.used).toBe(0); // other phones' share is untouched
  guard.closeStream(1);
  expect(guard.bufferedBytes).toBe(0);
});

test("a request left half-sent expires on the sweep, not only when its next frame comes", () => {
  const guard = new CompanionStreamGuard();
  const t0 = 1_000_000;
  expect(guard.ingestRequestFrame({ type: FrameType.REQ_CHUNK, streamId: 1, seq: 0, payload: Buffer.alloc(1_000) }, t0)).toMatchObject({ ok: true });
  expect(guard.bufferedBytes).toBe(1_000);
  expect(guard.expireAssemblies(t0 + 10)).toEqual([]);
  expect(guard.expireAssemblies(t0 + REQUEST_ASSEMBLY_DEADLINE_MS + 1)).toEqual([1]);
  expect(guard.bufferedBytes).toBe(0);
});

test("a watch record too big for one frame is dropped and reported as a cut", () => {
  const buffer = new LiveWatchBuffer();
  expect(buffer.push(Buffer.alloc(70_000)).accepted).toBe(false);
  const out = buffer.drainAvailable();
  expect(JSON.parse(out[0]!.toString("utf8"))).toEqual({ k: "cut", dropped: 1 });
});

test("frames round-trip", () => {
  const frame = { type: FrameType.PING, streamId: 0, seq: 7, payload: Buffer.from("x") };
  expect(decodeFrame(encodeFrame(frame))).toEqual(frame);
});
