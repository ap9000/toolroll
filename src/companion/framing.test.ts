/** Buffer accounting (M9): everything held for a phone — request assembly, unary responses, live-watch buffers — counts
 * against its 1 MiB and the daemon-wide 64 MiB; half-sent requests expire without a next frame; a record too big for a
 * frame is reported as a cut; the pacing bucket refills at its rate. */
import { expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CompanionStreamGuard, encodeFrame, FrameType, GlobalBufferBudget, LiveWatchBuffer, MAX_DAEMON_BUFFERED_BYTES, MAX_SESSION_BUFFERED_BYTES, PACING_PER_CONNECTION, PACING_PER_HOSTED_LINK, REQUEST_ASSEMBLY_DEADLINE_MS, TokenBucket, decodeFrame } from "./framing.js";

test("a unary response's bytes are charged to the phone's budget and the daemon's until its stream closes", () => {
  const budget = new GlobalBufferBudget();
  expect(budget.limitBytes).toBe(MAX_DAEMON_BUFFERED_BYTES);
  expect(MAX_DAEMON_BUFFERED_BYTES).toBe(64 * 1024 * 1024);
  const guard = new CompanionStreamGuard(budget);
  expect(guard.ingestRequestFrame({ type: FrameType.REQ, streamId: 1, seq: 0, payload: Buffer.from("{}") }).ok).toBe(true);
  expect(guard.reserveResponse(1, MAX_SESSION_BUFFERED_BYTES - 10)).toBe(true);
  expect(guard.reserveResponse(1, 100)).toBe(false); // the phone's 1 MiB is spoken for
  expect(budget.used).toBe(MAX_SESSION_BUFFERED_BYTES - 10);
  guard.closeStream(1);
  expect(guard.bufferedBytes).toBe(0);
  expect(budget.used).toBe(0);
});

test("live-watch records are charged to the session budget while buffered, released when drained or cleared", () => {
  const budget = new GlobalBufferBudget();
  const guard = new CompanionStreamGuard(budget);
  const watch = new LiveWatchBuffer({ reserve: bytes => guard.reserveWatch(bytes), release: bytes => guard.releaseWatch(bytes) });
  watch.credit = 0;
  for (let n = 0; n < 4; n++) watch.push(Buffer.alloc(10_000));
  expect(guard.bufferedBytes).toBe(40_000);
  expect(budget.used).toBe(40_000);
  watch.grantCredit(2);
  expect(watch.drainAvailable()).toHaveLength(2);
  expect(guard.bufferedBytes).toBe(20_000);
  // A full session budget (a held response elsewhere) turns a new record into a cut rather than memory.
  expect(guard.ingestRequestFrame({ type: FrameType.REQ, streamId: 1, seq: 0, payload: Buffer.from("{}") }).ok).toBe(true);
  expect(guard.reserveResponse(1, MAX_SESSION_BUFFERED_BYTES - 20_000)).toBe(true);
  expect(watch.push(Buffer.alloc(10_000)).accepted).toBe(true); // an older record gave way for it
  expect(watch.pendingCut).toBe(1);
  expect(guard.bufferedBytes).toBe(MAX_SESSION_BUFFERED_BYTES);
  watch.clear();
  guard.closeStream(1);
  expect(guard.bufferedBytes).toBe(0);
  expect(budget.used).toBe(0);
});

test("the pacing bucket spends its burst, then refills at its rate; the budgets are the frozen wire numbers", () => {
  const wire = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "test", "fixtures", "companion-wire.json"), "utf8")) as { relay: { macPacing: { perConnection: { bytesPerMin: number; bytesBurst: number }; perHostedLink: { bytesPerMin: number; bytesBurst: number } } } };
  expect(PACING_PER_CONNECTION).toEqual({ ratePerMin: wire.relay.macPacing.perConnection.bytesPerMin, burst: wire.relay.macPacing.perConnection.bytesBurst });
  expect(PACING_PER_HOSTED_LINK).toEqual({ ratePerMin: wire.relay.macPacing.perHostedLink.bytesPerMin, burst: wire.relay.macPacing.perHostedLink.bytesBurst });
  const bucket = new TokenBucket(60_000, 1_000, 0);
  expect(bucket.take(1_000, 0)).toBe(true);
  expect(bucket.take(1, 0)).toBe(false);
  expect(bucket.waitFor(500, 0)).toBe(500);
  expect(bucket.take(500, 500)).toBe(true);
  expect(bucket.available(10_000_000)).toBe(1_000); // never past its burst
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
