/**
 * The built CLI loads. Every command but the fast ones pulls in the whole store, and a value read at load across an import
 * cycle fails there and nowhere else: unit tests enter the graph at another module, so they pass while every command dies.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

test("a command past the fast path starts from the built CLI", () => {
  const home = mkdtempSync(join(tmpdir(), "cli-loads-"));
  try {
    const out = execFileSync(process.execPath, ["dist/bin.js", "contract", "--commands"], { env: { PATH: process.env["PATH"] ?? "", HOME: home, XDG_CONFIG_HOME: home }, encoding: "utf8" });
    expect(out).toContain("card");
  } finally { rmSync(home, { recursive: true, force: true }); }
});
