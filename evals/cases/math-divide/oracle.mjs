// The hidden check's own answers (zero dependencies). Run only by the plane's oracle process, never inside a world or
// the fence: `inputs` draws fresh inputs from a source seeded by each grading's nonce, and `expected` is the answer
// the oracle computes itself for each one.
export const files = ["src/math.js"];
const OPS = ["add", "divide"];
export function inputs(random) {
  const int = (low, high) => low + Math.floor(random() * (high - low + 1));
  return Array.from({ length: 14 }, (_, at) => ({ op: OPS[at % OPS.length], a: int(-40, 40), b: at % 5 === 4 ? 0 : int(-12, 12) }));
}
export function expected({ op, a, b }) {
  if (op === "add") return { value: a + b };
  return b === 0 ? { threw: true } : { value: a / b };
}
