import { expect, test } from "vitest";
import { middlePath } from "./views/projects-view.js";

test("a long project path keeps its start and end, never half a character", () => {
  // A path that fits still splits, so a narrow line clips only its start.
  expect(middlePath("~/short")).toEqual({ head: "", tail: "~/short" });
  const fits = middlePath("~/Documents/clients/ops-console", 44);
  expect(fits.head + fits.tail).toBe("~/Documents/clients/ops-console");
  expect(fits.tail.endsWith("ops-console")).toBe(true);
  const cut = middlePath("~/Documents/😀😀😀😀😀😀😀😀😀😀/clients/ops-console-with-a-long-name", 24);
  expect(Array.from(cut.head + cut.tail)).toHaveLength(24);
  expect(cut.head.endsWith("…")).toBe(true);
  expect(cut.tail.endsWith("long-name")).toBe(true);
  expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(cut.head + cut.tail)).toBe(false);
  // A limit too small to elide keeps the whole path.
  expect(middlePath("~/a/b/c/d/e/f/g", 1)).toEqual({ head: "~/a/b/c/d/e/f/g", tail: "" });
});
