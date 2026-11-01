// The hidden check's own answers (zero dependencies). Run only by the plane's oracle process, never inside a world or
// the fence: `inputs` draws fresh inputs from a source seeded by each grading's nonce, and `expected` is the answer
// the oracle computes itself for each one.
export const files = ["slug.js", "catalog.js"];
const CHARS = "abcXYZ019 &!-_.,";
export function inputs(random) {
  const int = (low, high) => low + Math.floor(random() * (high - low + 1));
  const word = () => { let out = ""; const length = int(1, 12); for (let i = 0; i < length; i++) out += CHARS[int(0, CHARS.length - 1)]; return /[a-z0-9]/i.test(out) ? out : out + "q"; };
  const out = [];
  for (let i = 0; i < 8; i++) out.push({ kind: "slug", text: word() });
  for (let i = 0; i < 6; i++) {
    const titles = Array.from({ length: int(0, 4) }, word);
    if (i % 3 === 0 && titles.length > 0) titles.push(titles[0].toUpperCase() + "!");
    out.push({ kind: "catalog", titles });
  }
  return out;
}
const slug = text => text.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
export function expected(input) {
  if (input.kind === "slug") return { value: slug(input.text) };
  const records = input.titles.map(title => ({ title, slug: slug(title) }));
  return new Set(records.map(one => one.slug)).size === records.length ? { value: records } : { threw: true };
}
