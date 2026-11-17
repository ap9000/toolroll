/**
 * Property tests (fast-check): what every one of them runs with. 200 generated cases keeps each property well under a
 * second. On a failure fast-check prints the counterexample with its `seed` and `path`; pass them back as
 * `{ ...PROPERTY, seed, path }` to replay exactly that case.
 */
export const PROPERTY = { numRuns: 200 } as const;

/** A deterministic shuffle of `items` by `seed` (a small LCG): the same seed, the same order. */
export function shuffled<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  let state = (seed >>> 0) || 1;
  for (let at = out.length - 1; at > 0; at--) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    const pick = state % (at + 1);
    [out[at], out[pick]] = [out[pick]!, out[at]!];
  }
  return out;
}
