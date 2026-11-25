/**
 * The Mac app and the web UI are one product: the app's colours are the design tokens (src/design/tokens.css), light
 * and dark, never a second hand-tuned palette. mac/Sources/ToolrollApp/Theme.swift writes each as
 * `dynamic(light: 0x…, dark: [isHighContrast ? 0x… :] 0x…)`; this holds those to the tokens so they can't drift.
 */
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const root = new URL("../", import.meta.url);
const css = readFileSync(new URL("src/design/tokens.css", root), "utf8");
const swift = readFileSync(new URL("mac/Sources/ToolrollApp/Theme.swift", root), "utf8");

/** A token's value inside the first block that starts at `selector`. */
function tokenIn(selector: string, name: string): string {
  const start = css.indexOf(selector);
  if (start === -1) throw new Error(`no ${selector} block`);
  const block = css.slice(start, css.indexOf("}", start));
  const value = new RegExp(`--so-${name}:\\s*(#[0-9a-fA-F]{6})\\b`).exec(block)?.[1];
  if (value === undefined) throw new Error(`--so-${name} is not a hex in ${selector}`);
  return value.toUpperCase();
}

/** The app's light and (standard-contrast) dark hex for a palette entry. */
function appColour(name: string): { light: string; dark: string } {
  const body = new RegExp(`public static var ${name}: Color \\{[\\s\\S]*?dynamic\\(light: 0x([0-9A-Fa-f]{6}), dark: ([^)]*)\\)`).exec(swift);
  if (body === null) throw new Error(`Theme.swift has no dynamic(...) for ${name}`);
  const darks = [...body[2]!.matchAll(/0x([0-9A-Fa-f]{6})/g)].map(match => match[1]!);
  return { light: `#${body[1]!.toUpperCase()}`, dark: `#${darks[darks.length - 1]!.toUpperCase()}` };
}

const PAIRS: [app: string, token: string][] = [
  ["ground", "ground"], ["paper", "paper"], ["raised", "raised"], ["ink", "ink"], ["muted", "muted"],
  ["line", "line"], ["live", "live"], ["danger", "danger"],
];

describe("the Mac app's palette is the web's design tokens", () => {
  test.each(PAIRS)("%s matches --so-%s in light and dark", (app, token) => {
    expect(appColour(app)).toEqual({ light: tokenIn(":root {", token), dark: tokenIn(':root[data-theme="dark"]', token) });
  });
});
