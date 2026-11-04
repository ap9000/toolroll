/** A long description filed as a task: its title is cut at a whole word with an ellipsis, never mid-word. */
import { describe, expect, test } from "vitest";
import { TASK_TEXT_LIMITS, titleWithin, validateTaskText } from "./task-text.js";

const LONG = "Format prices with a currency symbol everywhere they are shown, including the README's examples, the error messages and every test name that mentions an amount, without changing what any function returns";

describe("titleWithin", () => {
  test("within the limit: as typed", () => {
    expect(titleWithin("Round prices to whole cents")).toBe("Round prices to whole cents");
    expect(titleWithin("a".repeat(TASK_TEXT_LIMITS.title))).toBe("a".repeat(TASK_TEXT_LIMITS.title));
  });
  test("longer: the last whole word that fits, then an ellipsis, and a valid title", () => {
    const title = titleWithin(LONG);
    expect(title).toBe("Format prices with a currency symbol everywhere they are shown, including the README's examples, the error messages and every test name that mentions an amount, without changing what any function…");
    expect(title.length).toBeLessThanOrEqual(TASK_TEXT_LIMITS.title);
    expect(LONG.startsWith(title.slice(0, -1))).toBe(true);
    expect(validateTaskText({ title })).toBeNull();
  });
  test("no trailing comma before the ellipsis; whitespace runs read as one space; one unbroken word is cut", () => {
    expect(titleWithin(`${"word ".repeat(30)}tail, more words here`, 40)).toBe("word word word word word word word word…");
    expect(titleWithin(`alpha,  beta\n\ngamma ${"x".repeat(50)}`, 30)).toBe("alpha, beta gamma…");
    expect(titleWithin("y".repeat(300))).toBe(`${"y".repeat(TASK_TEXT_LIMITS.title - 1)}…`);
  });
});
