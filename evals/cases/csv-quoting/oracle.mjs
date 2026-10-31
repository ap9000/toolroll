// The hidden check's own answers (zero dependencies). Run only by the plane's oracle process, never inside a world or
// the fence: `inputs` draws fresh inputs from a source seeded by each grading's nonce, and `expected` is the answer
// the oracle computes itself for each one.
export const files = ["csv.js"];
const PARTS = ["a", "b c", ",", '"', "\n", "x", "0", ""];
export function inputs(random) {
  const int = (low, high) => low + Math.floor(random() * (high - low + 1));
  const field = () => random() < 0.15 ? int(0, 99) : Array.from({ length: int(0, 3) }, () => PARTS[int(0, PARTS.length - 1)]).join("");
  return Array.from({ length: 10 }, () => ({ rows: Array.from({ length: int(0, 3) }, () => Array.from({ length: int(1, 4) }, field)) }));
}
const cell = value => { const text = String(value); return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text; };
export function expected({ rows }) {
  return { value: rows.length === 0 ? "" : rows.map(row => row.map(cell).join(",")).join("\r\n") + "\r\n" };
}
