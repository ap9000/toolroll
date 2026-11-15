import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
// @ts-expect-error plain ESM script without declarations
import { checkedEnv } from "../scripts/e2e-kit.mjs";
// @ts-expect-error plain ESM script without declarations
import { makeTempRoot, removeRoot } from "../scripts/suite-lifecycle.mjs";

// Before any world exists (this kit's own unit tests), scripts/e2e-kit.mjs checkedEnv still refuses the account's own
// home, a credential and a startup hook; and a run's cleanup removes only folders it recorded making.

describe("checkedEnv before any world exists", () => {
  it("passes this test worker's own environment", () => {
    expect(checkedEnv(process.env)["HOME"]).toBe(process.env["HOME"]);
  });

  it("refuses the account's own home, a credential and a startup hook", () => {
    expect(() => checkedEnv({ ...process.env, HOME: userInfo().homedir })).toThrow(/before any world exists/);
    expect(() => checkedEnv(process.env, { GH_TOKEN: "x" })).toThrow(/GH_TOKEN/);
    expect(() => checkedEnv(process.env, { BASH_ENV: "/x" })).toThrow(/BASH_ENV/);
    expect(() => checkedEnv({ ...process.env, NODE_OPTIONS: "--require /x.js" })).toThrow(/NODE_OPTIONS/);
  });
});

describe("a run's cleanup", () => {
  it("removes a root it made and recorded, never a path it didn't", () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "so-not-ours-")));
    try {
      writeFileSync(join(outside, "vt.sh"), "#!/bin/zsh\n");
      removeRoot(outside);
      expect(realpathSync(join(outside, "vt.sh"))).toBe(join(outside, "vt.sh"));
      const ours = makeTempRoot("so-ours-");
      mkdirSync(join(ours, "inside"));
      removeRoot(ours);
      expect(() => realpathSync(ours)).toThrow();
    } finally { rmSync(outside, { recursive: true, force: true }); }
  });
});
