/**
 * A process ID no real process can hold, for tests that mean "a process that is not real". A small hard-coded ID
 * (4242) is a real process often enough: a browser tab on a laptop, anything on a CI runner, and the liveness check
 * under test then sees it running. Every value here is above every supported platform's limit: macOS stops at
 * 99,999 and Linux's pid_max at 4,194,304 (2^22). Windows has no documented ceiling but only ever hands out
 * multiples of 4, and every value here is odd. All stay well inside the 2,147,483,647 the code accepts as a PID.
 *
 * Give each fake process of a fixture its own offset (fakePid(1), fakePid(2), ...) and derive parents and groups
 * from the same calls, so the topology reads the same as it did with literals. A test about a real live or exited
 * process spawns one instead; src/fake-pid.test.ts fails on any new literal low PID.
 */
export const FAKE_PID_BASE = 4_200_001;
export const FAKE_PID_MAX_OFFSET = 99_999;

export function fakePid(offset = 0): number {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > FAKE_PID_MAX_OFFSET) throw new RangeError(`fakePid offset must be an integer from 0 to ${FAKE_PID_MAX_OFFSET}`);
  return FAKE_PID_BASE + offset * 2;
}
