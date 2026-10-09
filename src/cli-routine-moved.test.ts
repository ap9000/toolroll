/**
 * v115: routines became scheduled flows. For one release every former `toolroll routine …` command answers with one
 * line pointing to flows, changes nothing (no database is opened or created), exits 0, and stays out of help and the
 * contract.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { main, ROUTINES_MOVED } from "./cli.js";
import { openStore } from "./store.js";

const LEGACY: readonly string[][] = [
  [],
  ["list"], ["list", "--json"],
  ["add", "nightly-deps", "--repo", "/tmp/x", "--goal", "Refresh the lockfile", "--schedule", "daily:03:30", "--acceptance", "It passes.|check"],
  ["show", "nightly-deps"],
  ["approve", "nightly-deps", "--yes", "--digest", "abc", "--as", "alex", "--token", "t"],
  ["refresh", "nightly-deps"],
  ["pause", "nightly-deps"], ["resume", "nightly-deps"],
  ["run-now", "nightly-deps", "--as", "alex", "--token", "t"],
  ["edit", "nightly-deps", "--goal", "x"], ["--help"],
];

describe("`toolroll routine …` after routines became scheduled flows", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "toolroll-routine-moved-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test("every legacy invocation prints only the pointer to flows, exits 0, and creates no database", async () => {
    const db = join(dir, "orders.db");
    for (const rest of LEGACY) {
      const lines: string[] = [];
      const code = await main(["routine", ...rest, "--db", db], line => lines.push(line));
      expect(code, rest.join(" ")).toBe(0);
      if (rest.includes("--json")) {
        expect(lines).toHaveLength(1);
        expect(JSON.parse(lines[0]!)).toMatchObject({ ok: true, command: "routine", message: ROUTINES_MOVED });
      } else {
        expect(lines, rest.join(" ")).toEqual([ROUTINES_MOVED]);
      }
    }
    expect(existsSync(db)).toBe(false);
    expect(ROUTINES_MOVED).toBe("Routines are now scheduled flows: see `toolroll flows list` (your routines were moved there).");
  });

  test("an existing database is left byte for byte as it was", async () => {
    const db = join(dir, "orders.db");
    openStore(db).close();
    const before = readFileSync(db);
    for (const rest of LEGACY) await main(["routine", ...rest, "--db", db], () => undefined);
    expect(readFileSync(db).equals(before)).toBe(true);
  });

  test("it is hidden: neither help nor the contract names it", async () => {
    const help: string[] = [];
    await main(["help"], line => help.push(line));
    expect(help.join("\n")).not.toMatch(/toolroll routine\b/);
    const contract: string[] = [];
    expect(await main(["contract", "--json"], line => contract.push(line))).toBe(0);
    expect(contract.join("\n")).not.toMatch(/"routine( [a-z-]+)?"/);
  });
});
