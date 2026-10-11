import { afterEach, beforeEach, expect, test } from "vitest";
import { openStore, type Store } from "./store.js";
import { SWEEP_FALLBACK_MS, sweepIfMoved } from "./sweep-gate.js";

let store: Store;
beforeEach(() => { store = openStore(":memory:"); });
afterEach(() => store.close());

const t0 = new Date("2026-10-11T12:00:00.000Z");
const later = (ms: number) => new Date(t0.getTime() + ms);

test("a sweep runs again only after the wake sequence moves or the fallback minute passes", () => {
  let passes = 0;
  const sweep = (now: Date) => sweepIfMoved(store, "assignment-status:test", now, () => { passes += 1; });
  expect(sweep(t0)).toBe(true);
  expect(sweep(later(5_000))).toBe(false);
  store.bumpWake();
  expect(sweep(later(10_000))).toBe(true);
  expect(sweep(later(10_000 + SWEEP_FALLBACK_MS - 1))).toBe(false);
  expect(sweep(later(10_000 + SWEEP_FALLBACK_MS))).toBe(true);
  // A clock that went backwards is not trusted to mean "recent".
  expect(sweep(t0)).toBe(true);
  expect(passes).toBe(4);
});

test("a cycle part-way through its pages always continues, and a failed pass is retried", () => {
  const key = "assignment-handoff:test";
  expect(sweepIfMoved(store, key, t0, () => store.setServiceCursor(key, 50, t0))).toBe(true);
  expect(sweepIfMoved(store, key, later(1_000), () => store.setServiceCursor(key, 0, t0))).toBe(true);
  expect(sweepIfMoved(store, key, later(2_000), () => {})).toBe(false);
  store.bumpWake();
  expect(() => sweepIfMoved(store, key, later(3_000), () => { throw new Error("disk"); })).toThrow("disk");
  expect(sweepIfMoved(store, key, later(4_000), () => {})).toBe(true);
  // Each consumer keeps its own cycle.
  expect(sweepIfMoved(store, "lead:1:scan", later(4_000), () => {})).toBe(true);
});
