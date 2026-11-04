/** The one terminal sanitizer (terminal-text.ts): escapes and controls written by someone else never reach a terminal. */
import { describe, expect, test } from "vitest";
import { cleanLiveText } from "./live-records.js";
import { cleanTerminalLine, terminalText } from "./terminal-text.js";

const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/;

describe("terminalText", () => {
  test("clear-screen, hyperlink, cursor-up, 8-bit CSI and carriage-return overwrite tricks become plain text", () => {
    const hostile = "Goal: fix the footer\x1b[2J\x1b[H\x1b]8;;https://evil.example\x07click here\x1b]8;;\x07\x1b[1A\x9b2Kdone\rApproved by nobody\x1b]0;title\x1b\\ \x1bc\x08\x07 tab\there\u202eevil";
    const clean = terminalText(hostile);
    expect(clean).toBe("Goal: fix the footerclick heredoneApproved by nobody  tab hereevil");
    expect(clean).not.toMatch(CONTROL);
    expect(clean).not.toContain("\x1b");
  });
  test("newlines are kept between cleaned lines; a lone carriage return is not a line break", () => {
    expect(terminalText("one\x1b[31m red\x1b[0m\ntwo\r\nthree")).toBe("one red\ntwo\nthree");
  });
  test("ordinary words, accents and emoji are untouched", () => {
    for (const words of ["Round prices to whole cents.", "Café — naïve façade", "Ship it 🚀", "a | b, c: d"]) expect(terminalText(words)).toBe(words);
  });
  test("the live view and peek use the same sanitizer", () => {
    const line = "x\x1b[2Jy\x9b1Az\x1b]8;;e\x07w";
    expect(cleanLiveText(line)).toBe(cleanTerminalLine(line));
  });
});
