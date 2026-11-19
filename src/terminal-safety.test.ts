import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { TerminalSafetyFilter } from "./terminal-safety.js";

const corpus: { name: string; chunks: string[]; safe: string }[] = JSON.parse(readFileSync(new URL("../test/fixtures/terminal-attacks.json", import.meta.url), "utf8"));
function filtered(chunks: Uint8Array[]): string {
  const filter = new TerminalSafetyFilter();
  return chunks.map(c => filter.write(c)).join("") + filter.finish();
}
test.each(corpus)("$name: same policy across all byte boundaries", ({ chunks, safe }) => {
  const bytes = Buffer.concat(chunks.map(c => Buffer.from(c, "hex")));
  expect(filtered(chunks.map(c => Buffer.from(c, "hex")))).toBe(safe);
  expect(filtered([...bytes].map(b => Buffer.from([b])))).toBe(safe);
  for (let i = 0; i <= bytes.length; i++) expect(filtered([bytes.subarray(0, i), bytes.subarray(i)])).toBe(safe);
  // Re-filtering cannot create a forbidden sequence or change the safe stream.
  expect(filtered([Buffer.from(safe)])).toBe(safe);
});

test("C1 strings, cancellation attempts, malformed data and partial controls fail closed", () => {
  for (const start of ["\u0090", "\u0098", "\u009d", "\u009e", "\u009f"]) {
    expect(filtered([Buffer.from(`OK${start}secret\x18\x1b[31m\u009c!`)])).toBe("OK!");
  }
  expect(filtered([Buffer.from("OK\x1b[31")])).toBe("OK");
  expect(filtered([Buffer.from("OK\x1b]"), Buffer.alloc(1 << 20, 65)])).toBe("OK");
  expect(filtered([Buffer.from("\x1b[?2004h\x1b[?2004l\x1b[5 q")])).toBe("\x1b[?2004h\x1b[?2004l\x1b[5 q");
  const filter = new TerminalSafetyFilter();
  filter.finish();
  expect(() => filter.write(Buffer.from("late"))).toThrow("finished");
});
