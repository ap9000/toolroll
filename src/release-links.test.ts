import { mkdirSync, mkdtempSync, readdirSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { findCliLinks, restoreCliLinks, switchCliLinks } from "./release-links.js";

/** A temp-only PATH (never the machine's: real links there are writable) with an old and a new runtime's bin.js. */
function place() {
  const root = mkdtempSync(join(tmpdir(), "so-release-links-"));
  const bin = join(root, "bin"), old = join(root, "old", "dist"), next = join(root, "new", "dist");
  for (const dir of [bin, old, next]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(old, "bin.js"), ""); writeFileSync(join(next, "bin.js"), "");
  return { root, bin, old: join(old, "bin.js"), next: join(next, "bin.js") };
}

describe("moving both CLI names to a deployed runtime", () => {
  test("points both names at <runtime>/bin.js, each link replaced whole", () => {
    const p = place();
    symlinkSync(p.old, join(p.bin, "toolroll")); symlinkSync(p.old, join(p.bin, "standing-orders"));
    const links = findCliLinks(p.bin);
    expect(links).toEqual([{ name: "toolroll", path: join(p.bin, "toolroll"), before: p.old }, { name: "standing-orders", path: join(p.bin, "standing-orders"), before: p.old }]);
    const checked: string[] = [];
    switchCliLinks(links, p.next, path => { checked.push(path); return true; });
    expect(readlinkSync(join(p.bin, "toolroll"))).toBe(p.next);
    expect(readlinkSync(join(p.bin, "standing-orders"))).toBe(p.next);
    expect(checked).toEqual([join(p.bin, "toolroll"), join(p.bin, "standing-orders")]);
    // No temporary link is left behind, and doing it again changes nothing.
    expect(readdirSync(p.bin).sort()).toEqual(["standing-orders", "toolroll"]);
    switchCliLinks(links, p.next, () => true);
    expect(readlinkSync(join(p.bin, "toolroll"))).toBe(p.next);
  });

  test("a name that doesn't answer as the new build puts every link back where it was", () => {
    const p = place();
    symlinkSync(p.old, join(p.bin, "toolroll"));
    const links = findCliLinks(p.bin);
    // standing-orders was not on PATH: it is made beside toolroll, and removed again on failure.
    expect(links[1]).toEqual({ name: "standing-orders", path: join(p.bin, "standing-orders"), before: null });
    expect(() => switchCliLinks(links, p.next, path => !path.endsWith("standing-orders"))).toThrow(/standing-orders does not answer/);
    expect(readlinkSync(join(p.bin, "toolroll"))).toBe(p.old);
    expect(readdirSync(p.bin)).toEqual(["toolroll"]);
  });

  test("the saved targets restore links a killed relink had already moved", () => {
    const p = place();
    symlinkSync(p.old, join(p.bin, "toolroll")); symlinkSync(p.old, join(p.bin, "standing-orders"));
    const saved = findCliLinks(p.bin);
    switchCliLinks(saved, p.next, () => true);
    // A rerun finds them at the new runtime already; the saved list still knows where they were.
    expect(findCliLinks(p.bin).every(one => one.before === p.next)).toBe(true);
    restoreCliLinks(saved);
    expect(readlinkSync(join(p.bin, "toolroll"))).toBe(p.old);
    expect(readlinkSync(join(p.bin, "standing-orders"))).toBe(p.old);
  });

  test("never replaces a name that is a file, and refuses a missing runtime or no names at all", () => {
    const p = place();
    writeFileSync(join(p.bin, "toolroll"), "#!/bin/sh\n");
    symlinkSync(p.old, join(p.bin, "standing-orders"));
    expect(() => switchCliLinks(findCliLinks(p.bin), p.next, () => true)).toThrow(/is not a link/);
    expect(readlinkSync(join(p.bin, "standing-orders"))).toBe(p.old);
    expect(() => switchCliLinks(findCliLinks(join(p.root, "empty")), p.next, () => true)).toThrow(/no CLI name/);
    const fresh = place();
    symlinkSync(fresh.old, join(fresh.bin, "toolroll")); symlinkSync(fresh.old, join(fresh.bin, "standing-orders"));
    expect(() => switchCliLinks(findCliLinks(fresh.bin), join(fresh.root, "gone", "bin.js"), () => true)).toThrow(/does not exist/);
    expect(readlinkSync(join(fresh.bin, "toolroll"))).toBe(fresh.old);
  });
});
