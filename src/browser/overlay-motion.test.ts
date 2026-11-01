import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

/* The console's overlays arrive and leave on Radix data-state keyframes, and
 * reduce to a plain fade under prefers-reduced-motion. These read the shipped
 * stylesheet, so a changed value fails here rather than only on screen. */
const css = readFileSync(join(import.meta.dirname, "workspace.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const reduceAt = css.indexOf("@media (prefers-reduced-motion: reduce) {\n  .so-workspace *");
const reduce = css.slice(reduceAt, css.indexOf("\n}\n", reduceAt));
const base = css.slice(0, reduceAt);
const squash = (text: string) => text.replace(/\s+/g, " ").trim();
function rule(source: string, selector: string): string {
  const at = source.indexOf(`${selector} {`);
  expect(at, `${selector} has a rule`).toBeGreaterThanOrEqual(0);
  return squash(source.slice(at + selector.length + 2, source.indexOf("}", at)));
}
function keyframes(name: string): string {
  const at = css.indexOf(`@keyframes ${name} {`);
  expect(at, `@keyframes ${name}`).toBeGreaterThanOrEqual(0);
  return squash(css.slice(at, css.indexOf("} }", at) + 3));
}
const popovers = ':is([data-slot="dropdown-menu-content"], [data-slot="select-content"])';
const overlays = ':is(.ui-dialog-overlay, .ui-dialog-content, .so-navigation-dialog, [data-slot="dropdown-menu-content"], [data-slot="select-content"])';

describe("overlay motion", () => {

  test("under reduced motion every overlay, the drawer itself included, is a 120 ms fade with no transform", () => {
    expect(reduceAt).toBeGreaterThan(0);
    expect(rule(reduce, `${overlays}[data-state="open"]`)).toBe("animation: so-fade-in 120ms ease-out both !important;");
    expect(rule(reduce, `${overlays}[data-state="closed"]`)).toBe("animation: so-fade-out 120ms ease-out both !important;");
    for (const name of ["so-fade-in", "so-fade-out"]) expect(keyframes(name)).not.toContain("transform");
    // The blanket zero-duration rule covers descendants only, so it cannot cancel the fade.
    expect(rule(reduce, ".so-workspace *, .so-navigation-dialog *")).toContain("animation-duration: 0s !important;");
    expect(reduce).toContain("\n  .so-workspace *, .so-navigation-dialog * {");
  });
});
