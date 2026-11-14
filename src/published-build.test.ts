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

  test("pins undici as a direct dependency equal to the override, so global installs get the version #280 chose", () => {
    // package.json `overrides` reach only this checkout's installs, never `npm i -g toolroll` or npx. @slack/socket-mode
    // takes undici as a peer (^7 || ^8); undici 8 needs Node >= 22.19, and Toolroll supported >= 22.13 when #280 chose 7. The direct, exact
    // dependency is what makes npm 10, 11 and 12 install 7.30.1 for everyone; nothing in src imports it.
    const manifest = JSON.parse(readFileSync(resolve("package.json"), "utf8")) as { dependencies: Record<string, string>; overrides: Record<string, Record<string, string>> };
    const lock = JSON.parse(readFileSync(resolve("package-lock.json"), "utf8")) as { packages: Record<string, { version?: string }> };
    const pinned = manifest.dependencies["undici"];
    expect(pinned).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pinned).toBe(manifest.overrides["@slack/socket-mode"]?.["undici"]);
    expect(lock.packages["node_modules/undici"]?.version).toBe(pinned);
  });

  test("ships no source comments, and still runs as the bin (the shebang stays)", () => {
    for (const name of ["bin.js", "cli.js", "serve.js", "store.js"]) {
      const text = readFileSync(join(DIST, name), "utf8");
      expect(text.includes("/**"), name).toBe(false);
      if (name === "bin.js" || name === "cli.js") expect(text.startsWith("#!/usr/bin/env node\n"), name).toBe(true);
    }
  });
});
