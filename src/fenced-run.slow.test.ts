/**
 * The fenced-run harness against the real fence (docs/plans/trusted-release-reports.md, H3): a command it measures can't
 * reach the plane's state or what's outside its checkout, the stamp says what ran, and nothing of the harness stays.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { measure } from "../scripts/fenced-run.mjs";
import { linuxFenceAvailable, macosFenceAvailable } from "./agent-fence.js";
import { INSIDE_FENCE } from "../test/inside-fence.js";

const FENCED = !INSIDE_FENCE && (macosFenceAvailable() || linuxFenceAvailable());
const dir = realpathSync(mkdtempSync(join(tmpdir(), "so-fenced-run-test-")));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { cwd, stdio: "ignore" });

describe.skipIf(!FENCED)("measuring", () => {
  test("runs in the fence, is stamped, changes nothing outside, and refuses the unsandboxed level", async () => {
    const repo = join(dir, "repo");
    mkdirSync(repo);
    git(repo, "init", "--quiet", "--initial-branch", "main");
    writeFileSync(join(repo, "a.txt"), "a\n");
    git(repo, "add", "a.txt");
    git(repo, "commit", "--quiet", "-m", "a");
    const outside = join(dir, "outside.txt");
    const out = join(dir, "measurement.json");
    const command = `echo x >> ${outside} 2>/dev/null || echo outside-refused; test -f a.txt && echo checkout-ok; echo y > made.txt && echo write-ok`;
    const done = await measure({ level: "sandboxed", out, repo, command, minutes: 2 });
    expect(done.passed).toBe(true);
    expect(done.stdout.trim().split("\n")).toEqual(["outside-refused", "checkout-ok", "write-ok"]);
    expect(done.stamp).toMatchObject({ state: "current", stamp: { level: "sandboxed", policyDigest: expect.stringMatching(/^[0-9a-f]{32}$/) } });
    expect(JSON.parse(readFileSync(out, "utf8"))).toMatchObject({ version: 1, level: "sandboxed" });
    expect(existsSync(outside)).toBe(false);
    expect(existsSync(join(repo, "made.txt"))).toBe(false);
    await expect(measure({ level: "unsandboxed", out, repo, command })).rejects.toThrow(/needs no measuring/);
  }, 60_000);
});
