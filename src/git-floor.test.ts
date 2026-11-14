import { describe, expect, test } from "vitest";
import { doctorLines } from "./doctor.js";
import { GIT_FLOOR_WORDS, gitFloorWords, installedGitFloorProblem, parseGitVersion } from "./git-floor.js";

describe("the git floor (README, Requirements)", () => {
  test("is 2.41: the global --attr-source option", () => { expect(GIT_FLOOR_WORDS).toBe("2.41"); });
  test.each([
    ["git version 2.40.4", "Toolroll needs git 2.41 or newer, and this machine's git is 2.40.4. Install a newer git (and put it first on PATH): `brew install git`, or update Xcode's Command Line Tools in Software Update. Then start Toolroll again."],
    ["git version 2.39.5", "Toolroll needs git 2.41 or newer, and this machine's git is 2.39.5. Install a newer git (and put it first on PATH): `brew install git`, or update Xcode's Command Line Tools in Software Update. Then start Toolroll again."],
    ["git version 1.99.0", expect.stringContaining("this machine's git is 1.99.0")],
    ["git version 2.41.3", null],
    ["git version 2.47.3", null],
    ["git version 2.50.1 (Apple Git-155)", null],
    ["git version 3.0", null],
    ["not git at all", null],
  ])("%s", (answer, words) => { expect(gitFloorWords(answer, "darwin")).toEqual(words); });
  test("i1: on Linux it says where a newer git than the distribution's comes from", () => {
    expect(gitFloorWords("git version 2.34.1", "linux")).toBe("Toolroll needs git 2.41 or newer, and this machine's git is 2.34.1. Install a newer git (and put it first on PATH): get one from https://git-scm.com/downloads/linux (Ubuntu: `sudo add-apt-repository ppa:git-core/ppa && sudo apt update && sudo apt install git`). Then start Toolroll again.");
  });
  test("parses the installed git, which these tests need above the floor", () => {
    expect(parseGitVersion("git version 2.50.1 (Apple Git-155)")).toEqual({ major: 2, minor: 50, words: "2.50.1" });
    expect(installedGitFloorProblem()).toBeNull();
  });
  test("the doctor names it first, apart from the secrets check", () => {
    const problem = gitFloorWords("git version 2.39.5")!;
    const lines = doctorLines({ ok: false, checked: [], findings: [], unreadable: [], notes: [], git: { floor: GIT_FLOOR_WORDS, problem } });
    expect(lines[0]).toBe(`Git: ${problem}`);
    expect(lines).toContain("No secrets found in Toolroll's service. A build can't read a key from it.");
  });
});
