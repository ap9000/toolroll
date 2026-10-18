/** A person's accent colour reaches the cookie and the page only as six hex digits. */
import { expect, test } from "vitest";
import { DEFAULT_ACCENT, accentStyle, normalHex, pinnedAccent } from "./accent-colors.js";

test("only six hex digits ever reach the cookie or the page", () => {
  expect(normalHex("#ABC")).toBe("#aabbcc");
  expect(normalHex("009473")).toBe("#009473");
  expect(normalHex("red")).toBeNull();
  expect(pinnedAccent("a=1; so-accent=009473")).toBe("#009473");
  expect(pinnedAccent(`so-accent=${DEFAULT_ACCENT.slice(1)}`)).toBeNull();
  expect(pinnedAccent("so-accent=%22%3E%3Cstyle")).toBeNull();
  expect(pinnedAccent(undefined)).toBeNull();
  expect(accentStyle("#009473")).toMatch(/^:root\{--so-signal:#[0-9a-f]{6};.*:root\[data-theme="dark"\]\{--so-signal:#[0-9a-f]{6};/);
});
