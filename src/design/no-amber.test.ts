/**
 * No amber on a page (DESIGN.md, the One Signal Rule): what waits on a person is ink, and a caution is neutral ink.
 * The warning token stays defined for one consumer only, the terminal's ANSI yellow. This guard fails when a page,
 * a stylesheet or a component reaches for the warning colour, or names amber, anywhere else.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const SRC = fileURLToPath(new URL("..", import.meta.url));

/** Where the warning token may be named: its generated definitions and the terminal palette. */
const WARNING_TOKEN_HOMES = new Set(["design/tokens.css", "design/theme.css", "browser/terminal-app.tsx"]);
/** Where the word may appear: a flow canvas zone can still be coloured "amber" (stored data), and this guard names it. */
const AMBER_WORD_HOMES = new Set(["flows.ts", "contracts/flow.ts", "browser/views/flow-view.tsx", "design/no-amber.test.ts"]);

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.(?:ts|tsx|css)$/.test(entry.name) ? [path] : [];
  });
}

const hits = (pattern: RegExp, allowed: Set<string>, skipTests: boolean): string[] => sources(SRC).flatMap(path => {
  const name = relative(SRC, path).split("\\").join("/");
  if (allowed.has(name) || (skipTests && /\.test\.tsx?$/.test(name))) return [];
  return readFileSync(path, "utf8").split("\n").flatMap((line, index) => pattern.test(line) ? [`${name}:${index + 1}`] : []);
});

test("only the token files and the terminal palette name the warning colour", () => {
  // The token itself, its Tailwind colour classes, and its light and dark values written out by hand.
  const warning = /--so-warning|--color-warning|\b(?:text|bg|border|ring|outline|fill|stroke|decoration|from|to|via)-warning\b|#ab6400|#ffca16|#fff4d5/i;
  expect(hits(warning, WARNING_TOKEN_HOMES, true)).toEqual([]);
});

test("nothing outside the flow canvas zones names amber", () => {
  expect(hits(/amber/i, AMBER_WORD_HOMES, false)).toEqual([]);
});

test("the needs-you colour is the signal ink, in light and in dark", () => {
  const tokens = readFileSync(join(SRC, "design/tokens.css"), "utf8");
  expect(tokens).toMatch(/--so-needs:\s*var\(--so-signal\);/);
  expect(tokens).toMatch(/--so-needs-soft:\s*var\(--so-signal-soft\);/);
  expect(tokens.match(/--so-needs(?:-soft)?:/g)).toHaveLength(2);
});
