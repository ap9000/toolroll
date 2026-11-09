import { afterEach, expect, test, vi } from "vitest";
import { WakeHub, WakePoker, wakeHubFor } from "./wake-hub.js";

afterEach(() => vi.useRealTimers());

/** A counter the hub reads, with a read count of its own. */
function counter() {
  let seq = 0;
  let reads = 0;
  return { bump: () => { seq++; }, read: () => { reads++; return seq; }, value: () => seq, reads: () => reads };
}

test("a bump between reading the baseline and waiting is never lost", async () => {
  vi.useFakeTimers();
  const wake = counter();
  const hub = new WakeHub(wake.read);
  const baseline = wake.value();
  wake.bump(); // lands after the caller read its baseline, before it registered
  const why = hub.changed({ baseline, deadline: Date.now() + 60_000 });
  await vi.advanceTimersByTimeAsync(50);
  await expect(why).resolves.toBe("wake");
  expect(hub.running()).toBe(false);
});

test("a wake resolves on the next beat; a deadline and a poke resolve with their own reason", async () => {
  vi.useFakeTimers();
  const wake = counter();
  const hub = new WakeHub(wake.read);
  const woken = hub.changed({ baseline: 0, deadline: Date.now() + 60_000 });
  await vi.advanceTimersByTimeAsync(200);
  expect(hub.waiting()).toBe(1);
  wake.bump();
  await vi.advanceTimersByTimeAsync(50);
  await expect(woken).resolves.toBe("wake");

  const timedOut = hub.changed({ baseline: wake.value(), deadline: Date.now() + 300 });
  await vi.advanceTimersByTimeAsync(250);
  expect(hub.waiting()).toBe(1);
  await vi.advanceTimersByTimeAsync(100);
  await expect(timedOut).resolves.toBe("deadline");

  const poker = new WakePoker();
  const poked = hub.changed({ baseline: wake.value(), deadline: Date.now() + 60_000, poker });
  const other = hub.changed({ baseline: wake.value(), deadline: Date.now() + 60_000 });
  poker.poke(); // at once, without waiting for a beat
  await expect(poked).resolves.toBe("poke");
  expect(hub.waiting()).toBe(1); // a poker ends only its own waits
  hub.poke(); // the stop signal ends every wait
  await expect(other).resolves.toBe("poke");
  expect(hub.running()).toBe(false);
});

test("until is checked every beat and already-true conditions resolve without a beat", async () => {
  vi.useFakeTimers();
  const wake = counter();
  const hub = new WakeHub(wake.read);
  let stopping = false;
  const stopped = hub.changed({ baseline: 0, deadline: Date.now() + 60_000, until: () => stopping });
  await vi.advanceTimersByTimeAsync(500);
  stopping = true;
  await vi.advanceTimersByTimeAsync(50);
  await expect(stopped).resolves.toBe("poke");
  const readsBefore = wake.reads();
  await expect(hub.changed({ baseline: 0, deadline: Date.now() + 60_000, until: () => true })).resolves.toBe("poke");
  await expect(hub.changed({ baseline: 0, deadline: Date.now() - 1 })).resolves.toBe("deadline");
  expect(wake.reads()).toBe(readsBefore);
});

test("one read per beat whatever the number of waiters, and the timer stops when nothing waits", async () => {
  vi.useFakeTimers();
  const wake = counter();
  const hub = new WakeHub(wake.read);
  const waits = Array.from({ length: 40 }, () => hub.changed({ baseline: 0, deadline: Date.now() + 60_000 }));
  await vi.advanceTimersByTimeAsync(1_000);
  expect(wake.reads()).toBe(20);
  expect(hub.reads()).toBe(20);
  wake.bump();
  await vi.advanceTimersByTimeAsync(50);
  await expect(Promise.all(waits)).resolves.toEqual(Array.from({ length: 40 }, () => "wake"));
  expect(hub.running()).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(wake.reads()).toBe(21); // nothing waits: nothing reads
});

test("a counter that can't be read reaches every waiter as the error", async () => {
  vi.useFakeTimers();
  const hub = new WakeHub(() => { throw new Error("database is locked"); });
  const one = hub.changed({ baseline: 0, deadline: Date.now() + 60_000 });
  const two = hub.changed({ baseline: 0, deadline: Date.now() + 60_000 });
  const settled = Promise.allSettled([one, two]);
  await vi.advanceTimersByTimeAsync(50);
  expect((await settled).map(result => result.status)).toEqual(["rejected", "rejected"]);
  expect(hub.running()).toBe(false);
});

test("one hub per store", () => {
  const store = { wakeSeq: () => 0 };
  expect(wakeHubFor(store)).toBe(wakeHubFor(store));
  expect(wakeHubFor({ wakeSeq: () => 0 })).not.toBe(wakeHubFor(store));
});
