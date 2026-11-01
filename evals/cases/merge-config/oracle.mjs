// The hidden check's own answers (zero dependencies). Run only by the plane's oracle process, never inside a world or
// the fence: `inputs` draws fresh inputs from a source seeded by each grading's nonce, and `expected` is the answer
// the oracle computes itself for each one.
export const files = ["config.js"];
const KEYS = ["port", "debug", "host", "keep", "mode"];
export function inputs(random) {
  const int = (low, high) => low + Math.floor(random() * (high - low + 1));
  const value = () => [0, 1, 80, false, true, "x", ""][int(0, 6)];
  return Array.from({ length: 10 }, () => {
    const base = {}, overrides = {};
    for (const key of KEYS) {
      if (random() < 0.6) base[key] = value();
      const roll = random();
      if (roll < 0.25) overrides[key] = null;
      else if (roll < 0.45) overrides[key] = { $undefined: true };
      else if (roll < 0.75) overrides[key] = value();
    }
    return { base, overrides };
  });
}
export function expected({ base, overrides }) {
  const out = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== null && typeof value === "object") continue;
    if (value === null) delete out[key]; else out[key] = value;
  }
  return { value: out, keptBase: true, keptOverrides: true };
}
