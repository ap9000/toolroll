// The hidden check's own answers (zero dependencies). Run only by the plane's oracle process, never inside a world or
// the fence: `inputs` draws fresh inputs from a source seeded by each grading's nonce, and `expected` is the answer
// the oracle computes itself for each one.
export const files = ["validate.js", "endpoint.js"];
export function inputs(random) {
  const int = (low, high) => low + Math.floor(random() * (high - low + 1));
  const name = () => {
    // Never over 20 characters untrimmed but within 20 trimmed: the goal leaves that open.
    const core = "abcdefghij".repeat(3).slice(0, random() < 0.2 ? int(21, 28) : int(0, 18));
    const pad = " ".repeat(core.length <= 16 ? int(0, 2) : 0);
    return pad + core + pad;
  };
  const values = () => [name(), int(0, 9), null, true];
  const out = [];
  for (let i = 0; i < 8; i++) out.push({ kind: "valid", value: values()[random() < 0.7 ? 0 : int(1, 3)] });
  for (let i = 0; i < 8; i++) {
    const shape = int(0, 4);
    out.push({ kind: "create", body: shape === 0 ? { absent: true } : shape === 1 ? null : shape === 2 ? {} : { name: values()[shape === 3 ? 0 : int(1, 3)] } });
  }
  return out;
}
const valid = value => typeof value === "string" && value.trim().length >= 1 && value.trim().length <= 20;
export function expected(input) {
  if (input.kind === "valid") return { value: valid(input.value) };
  const body = input.body?.absent ? undefined : input.body;
  return { value: valid(body?.name) ? { status: 201, body: { name: body.name.trim() } } : { status: 400, body: { error: "invalid name" } } };
}
