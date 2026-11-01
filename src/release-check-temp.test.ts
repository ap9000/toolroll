/** Run by a plane, the release check's temp folder is inside the check's launch folder (`so-cmd-…/tmp`); the planes it
 * starts would fence everything they make there as another launch's (release check 3240), so it takes a temp root
 * beside that folder (scripts/release-check.mjs enclosingLaunchOf). */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { enclosingLaunchOf } from "../scripts/release-check.mjs";

test("the launch folder a temp folder lies inside is found; a temp folder in none has none", () => {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "so-rc-test-")));
  try {
    const launch = join(parent, "so-cmd-AbC123");
    mkdirSync(join(launch, "tmp", "deeper"), { recursive: true });
    expect(enclosingLaunchOf(join(launch, "tmp"))).toBe(launch);
    expect(enclosingLaunchOf(join(launch, "tmp", "deeper"))).toBe(launch);
    mkdirSync(join(parent, "plain", "tmp"), { recursive: true });
    expect(enclosingLaunchOf(join(parent, "plain", "tmp"))).toBeNull();
    expect(enclosingLaunchOf(join(parent, "missing"))).toBeNull();
  } finally { rmSync(parent, { recursive: true, force: true }); }
});
