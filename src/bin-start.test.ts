import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

test("bare `toolroll` says it is starting from its first lines, before the CLI or anything heavy loads", () => {
  const bin = readFileSync(new URL("./bin.ts", import.meta.url), "utf8");
  const said = bin.indexOf('process.stdout.write("Starting Toolroll…\\n")');
  expect(said).toBeGreaterThan(0);
  // Before every import that loads the CLI or SQLite (the Node version checks above it are plain code).
  for (const heavy of ['import("./cli-fast.js")', 'import("./cli.js")', 'await sqliteHasFts5()']) {
    expect(bin.indexOf(heavy)).toBeGreaterThan(said);
  }
  // Only for a person's bare start at a terminal; every other command's output is untouched.
  expect(bin).toContain("argv.length === 0 && process.stdout.isTTY === true && process.stdin.isTTY === true");
  // Easy start doesn't say it twice.
  const easy = readFileSync(new URL("./easy-start.ts", import.meta.url), "utf8");
  expect(easy).toContain('Symbol.for("toolroll.starting-said")');
});
