// The hidden check's own answers (zero dependencies). Run only by the plane's oracle process, never inside a world or
// the fence: `inputs` draws fresh inputs from a source seeded by each grading's nonce, and `expected` is the answer
// the oracle computes itself for each one.
export const files = ["paginate.js"];
export function inputs(random) {
  const int = (low, high) => low + Math.floor(random() * (high - low + 1));
  return Array.from({ length: 12 }, () => {
    const items = Array.from({ length: int(0, 14) }, () => int(-50, 50));
    const args = [items];
    if (random() < 0.85) args.push(int(-4, 16));
    if (args.length === 2 && random() < 0.85) args.push(int(0, 7));
    return { args };
  });
}
export function expected({ args: [items, offset, limit] }) {
  const from = Math.max(0, offset ?? 0);
  return { value: items.slice(from, from + (limit ?? 10)), kept: true };
}
