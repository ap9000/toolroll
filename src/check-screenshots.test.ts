// Screenshots a project's own check writes (docs/plans/checks-screenshots.md v1): read without following anything,
// validated by signature, at most CHECK_SHOTS_MAX, and described so they never stand in for an acceptance criterion.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { CHECK_SCREENSHOT_CAPTURE, CHECK_SHOTS_MAX, checkScreenshotCapture, collectCheckScreenshots } from "./check-screenshots.js";
import { SCREENSHOT_CAPTURE } from "./result-evidence-readers.js";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("IHDR-synthetic-pixels")]);
let dir: string, checkout: string, shots: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "check-shots-")));
  checkout = join(dir, "checkout");
  shots = join(checkout, "evidence", "checks");
  mkdirSync(shots, { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("a check's screenshots", () => {
  test("valid images are collected in name order; anything else is named, never read", () => {
    writeFileSync(join(shots, "b-phone.png"), PNG);
    writeFileSync(join(shots, "a-desktop.png"), PNG);
    writeFileSync(join(shots, "fake.png"), "not an image");
    writeFileSync(join(shots, "notes.txt"), "ignored: not an image name");
    writeFileSync(join(dir, "outside.png"), PNG);
    symlinkSync(join(dir, "outside.png"), join(shots, "c-link.png"));
    const got = collectCheckScreenshots(checkout);
    expect(got.files.map(one => one.path)).toEqual(["evidence/checks/a-desktop.png", "evidence/checks/b-phone.png"]);
    expect(got.files.every(one => one.kind === "png")).toBe(true);
    expect(got.problems.map(one => one.path).sort()).toEqual(["evidence/checks/c-link.png", "evidence/checks/fake.png"]);
  });

  test("at most the cap, the rest named", () => {
    for (let at = 0; at < CHECK_SHOTS_MAX + 2; at++) writeFileSync(join(shots, `shot-${String(at).padStart(2, "0")}.png`), PNG);
    const got = collectCheckScreenshots(checkout);
    expect(got.files).toHaveLength(CHECK_SHOTS_MAX);
    expect(got.problems).toHaveLength(2);
  });

  test("a folder that is a link, or leads outside the checkout, is never read", () => {
    rmSync(join(checkout, "evidence"), { recursive: true });
    mkdirSync(join(dir, "elsewhere", "checks"), { recursive: true });
    writeFileSync(join(dir, "elsewhere", "checks", "x.png"), PNG);
    symlinkSync(join(dir, "elsewhere"), join(checkout, "evidence"));
    const got = collectCheckScreenshots(checkout);
    expect(got.files).toEqual([]);
    expect(got.problems).toEqual([{ path: "evidence/checks", problem: "the folder isn't a plain folder inside the checkout" }]);
  });

  test("no checkout (a check that never got one): nothing collected, nothing thrown", () => {
    expect(collectCheckScreenshots(join(dir, "missing"))).toEqual({ files: [], problems: [] });
  });

  test("no folder: nothing collected, nothing said", () => {
    rmSync(join(checkout, "evidence"), { recursive: true });
    expect(collectCheckScreenshots(checkout)).toEqual({ files: [], problems: [] });
  });

  test("described as a check's image of one commit, never as an agent's claimed screenshot", () => {
    const capture = checkScreenshotCapture("evidence/checks/a-desktop.png", "a".repeat(40), "png");
    expect(CHECK_SCREENSHOT_CAPTURE.exec(capture)?.slice(1, 3)).toEqual(["evidence/checks/a-desktop.png", "a".repeat(40)]);
    // The result page links acceptance criteria by the agent's capture only: a check's image never ticks one.
    expect(SCREENSHOT_CAPTURE.test(capture)).toBe(false);
  });
});
