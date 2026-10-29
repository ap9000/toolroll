/** Measuring checkouts never holds the console's event loop: `du` is awaited, not run synchronously. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { diskBytesAsync } from "./storage.js";

test("pages keep answering while du runs; its sizes are read, and what it missed is walked", async () => {
  const dir = mkdtempSync(join(tmpdir(), "so-disk-"));
  try {
    writeFileSync(join(dir, "missed"), "x".repeat(10_000));
    let finish: (out: string) => void = () => {};
    const pending = diskBytesAsync(["/measured", join(dir, "missed")], () => new Promise(done => { finish = done; }));
    let loopRan = false;
    await new Promise<void>(done => setImmediate(() => { loopRan = true; done(); }));
    expect(loopRan).toBe(true);
    finish("12\t/measured\n");
    const sizes = await pending;
    expect(sizes.get("/measured")).toBe(12 * 1024);
    expect(sizes.get(join(dir, "missed"))).toBeGreaterThan(0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
