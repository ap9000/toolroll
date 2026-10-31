// The hidden check's own answers (zero dependencies). Run only by the plane's oracle process, never inside a world or
// the fence: `inputs` draws fresh inputs from a source seeded by each grading's nonce, and `expected` is the answer
// the oracle computes itself for each one.
export const files = ["dedupe.js"];
export function inputs(random) {
  const int = (low, high) => low + Math.floor(random() * (high - low + 1));
  return Array.from({ length: 12 }, () => ({ rows: Array.from({ length: int(0, 10) }, (_, at) => {
    const n = int(0, 4);
    return { id: random() < 0.5 ? n : String(n), v: `r${at}` };
  }) }));
}
export function expected({ rows }) {
  const seen = new Set();
  const value = rows.filter(row => { const key = `${typeof row.id}:${row.id}`; if (seen.has(key)) return false; seen.add(key); return true; });
  return { value, kept: true, fresh: true };
}
