// The real-launchd canary (scripts/deploy-stop-canary.mjs) refuses before it calls anything: without the owner's
// explicit flag, in CI, off macOS, and with any label but its own throwaway form. Checked with a fake launchctl that
// only records a call; the canary itself is never run here.
import { describe, expect, test } from "vitest";
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CANARY_LABEL, canaryRefusal, runCanary } from "../scripts/deploy-stop-canary.mjs";

describe("the stop canary", () => {
  const fake = () => {
    const dir = mkdtempSync(join(tmpdir(), "fake-launchctl-"));
    const launchctl = join(dir, "launchctl"), called = join(dir, "called");
    writeFileSync(launchctl, `#!/bin/sh\necho "$@" >> '${called}'\nexit 113\n`);
    chmodSync(launchctl, 0o700);
    return { launchctl, called };
  };
  const approved = ["--owner-approved"];
  const cases: [string, { argv: string[]; env: Record<string, string>; platform: string }, string][] = [
    ["no owner flag", { argv: [], env: {}, platform: "darwin" }, "--owner-approved"],
    ["CI set", { argv: approved, env: { CI: "true" }, platform: "darwin" }, "never runs in CI"],
    ["CI set to 1", { argv: approved, env: { CI: "1" }, platform: "darwin" }, "never runs in CI"],
    ["not macOS", { argv: approved, env: {}, platform: "linux" }, "macOS launchd"],
    ["the real label", { argv: [...approved, "--label", "com.toolroll.browser"], env: {}, platform: "darwin" }, "throwaway label"],
    ["the older real label", { argv: [...approved, "--label", "com.standing-orders.browser"], env: {}, platform: "darwin" }, "throwaway label"],
    ["a canary-looking label with a suffix", { argv: [...approved, "--label", "com.toolroll.canary.0123456789abcdef.x"], env: {}, platform: "darwin" }, "throwaway label"],
    ["a label flag with no value", { argv: [...approved, "--label"], env: {}, platform: "darwin" }, "throwaway label"],
  ];
  test.each(cases)("refuses with %s and calls nothing", async (_name, given, words) => {
    const { launchctl, called } = fake();
    expect(canaryRefusal(given)).toContain(words);
    await expect(runCanary({ ...given, launchctl, uid: 501, say: () => {} })).rejects.toThrow(words);
    expect(existsSync(called)).toBe(false);
  });
  test("its own label form never matches a real service label", () => {
    for (const label of ["com.toolroll.browser", "com.standing-orders.browser", "com.toolroll.up", "com.toolroll.canary."]) expect(CANARY_LABEL.test(label)).toBe(false);
    expect(CANARY_LABEL.test("com.toolroll.canary.0123456789abcdef")).toBe(true);
    expect(canaryRefusal({ argv: [...approved, "--label", "com.toolroll.canary.0123456789abcdef"], env: {}, platform: "darwin" })).toBeNull();
  });
});
