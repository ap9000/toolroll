import { describe, test, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

/** The published build (tsconfig.build.json, scripts/postbuild.mjs): dist JavaScript only. The suite's global setup
 * builds dist before any test runs (test/ensure-build.ts). */
const DIST = resolve("dist");
const files = (readdirSync(DIST, { recursive: true }) as string[]).map(name => name.split("\\").join("/"));

describe("the published build", () => {
  test("ships no type declarations: nothing reads them (no types or exports in package.json), and they were half its files", () => {
    const manifest = JSON.parse(readFileSync(resolve("package.json"), "utf8")) as Record<string, unknown>;
    expect(manifest["types"] ?? manifest["typings"] ?? manifest["exports"]).toBeUndefined();
    // An older build's declarations are removed too, so a reused checkout packs what a clean one does.
    expect(files.filter(name => /\.d\.ts(?:\.map)?$/.test(name))).toEqual([]);
    expect(files.filter(name => name.endsWith(".map"))).toEqual([]);
  });

  test("ships no source comments, and still runs as the bin (the shebang stays)", () => {
    for (const name of ["bin.js", "cli.js", "serve.js", "store.js"]) {
      const text = readFileSync(join(DIST, name), "utf8");
      expect(text.includes("/**"), name).toBe(false);
      if (name === "bin.js" || name === "cli.js") expect(text.startsWith("#!/usr/bin/env node\n"), name).toBe(true);
    }
  });
});
