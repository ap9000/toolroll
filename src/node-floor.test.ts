/** One Node floor, said the same everywhere a person or npm reads it: the first Node 22 the whole store works on,
 * 22.20.0 (each official release checked by hand, 2026-11-13). Node 22.13.0–22.15.1 (SQLite 3.47.2 and 3.49.1) bundle
 * SQLite without FTS5, and `openStore` fails with "no such module: fts5"; on 22.16.0–22.19.0 node:sqlite fails the
 * store's writes ("column index out of range" starting a run). src/bin.ts holds the number; this test holds everything
 * else to it. */
import { expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (file: string) => readFileSync(resolve(file), "utf8");
const bin = read("src/bin.ts");
const floor = bin.match(/const FLOOR = \{ major: (\d+), minor: (\d+) \} as const;/);

test("the bin's floor is the first Node 22 the store works on, and npm's engines say the same", () => {
  expect(floor?.slice(1)).toEqual(["22", "20"]);
  const manifest = JSON.parse(read("package.json")) as { engines: { node: string } };
  expect(manifest.engines.node).toBe(">=22.20.0");
  const lock = JSON.parse(read("package-lock.json")) as { packages: Record<string, { engines?: { node?: string } }> };
  expect(lock.packages[""]?.engines?.node).toBe(">=22.20.0");
  // The fast check also refuses a Node above the floor whose SQLite has no FTS5.
  expect(bin).toContain('CREATE VIRTUAL TABLE fts5_probe USING fts5(x)');
});

test("install.sh, the README and the guides say 22.20, and nothing a person reads names the old floor", () => {
  const install = read("install.sh");
  expect(install).toContain('[ "$minor" -lt 20 ]');
  expect(install.match(/Node\.js 22\.20 or newer/g)?.length).toBe(3);
  expect(read("README.md")).toContain("Node.js 22.20+");
  expect(read("README.md")).toContain("node-%E2%89%A5%2022.20-171717");
  for (const file of ["README.md", "install.sh", "llms.txt", "CONTRIBUTING.md", "docs/team-server.md", "docs/guide/getting-started.md", "docs/guide/linux.md", "src/guides.ts"]) {
    expect(read(file), file).not.toMatch(/22\.13(?![\d])/);
  }
});
