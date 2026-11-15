import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error plain ESM script without declarations
import { checkedEnv, ownRoot, refusePort4180, spawnOwned } from "../scripts/e2e-kit.mjs";
// @ts-expect-error plain ESM script without declarations
import { isolatedEnvironment } from "../scripts/isolated-env.mjs";

// Every child a journey starts gets its environment checked right before it starts (scripts/e2e-kit.mjs checkedEnv):
// world.cli, world.start, spawnOwned and the kit's synchronous calls all go through it. A file of its own: registering
// a world root turns the check on for the rest of this process.

const dir = realpathSync(mkdtempSync(join(tmpdir(), "so-kit-env-")));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const root = join(dir, "world");
mkdirSync(root);
const world = isolatedEnvironment({ root, outer: process.env });
ownRoot(root);

describe("checkedEnv", () => {
  it("passes a world's own environment and overrides that stay inside it", () => {
    expect(checkedEnv(world.env, { NODE_OPTIONS: "", TOOLROLL_MATE_TRACE: "1" })["HOME"]).toBe(world.env.HOME);
  });

  it("refuses a child whose HOME, PATH or XDG folder an override points outside its world", () => {
    expect(() => checkedEnv(world.env, { HOME: "/Users/someone" })).toThrow(/outside every world/);
    expect(() => checkedEnv(world.env, { PATH: `/usr/local/bin:${world.env.PATH}` })).toThrow(/PATH entry/);
    expect(() => checkedEnv(world.env, { XDG_CONFIG_HOME: join(dir, "elsewhere") })).toThrow(/XDG_CONFIG_HOME/);
  });

  it("refuses the person's environment spread over a world's (the 2026-11-14 shape)", () => {
    expect(() => checkedEnv({ ...world.env, PATH: process.env["PATH"] })).toThrow();
    expect(() => checkedEnv({ ...world.env, HOME: dir })).toThrow(/outside every world/);
  });

  it("is what spawnOwned runs: a bad environment never starts", () => {
    expect(() => spawnOwned("bad", "/bin/sh", ["-c", "true"], { env: { ...world.env, HOME: "/" }, stdio: "ignore" })).toThrow(/outside every world/);
  });
});

describe("port 4180", () => {
  it("is refused outright in a synthetic run's arguments, as a flag or inside a shell command", () => {
    expect(() => refusePort4180(["up", "--port", "4180"])).toThrow(/4180/);
    expect(() => refusePort4180(["-c", "cd x && exec toolroll --port 4180"])).toThrow(/4180/);
    expect(refusePort4180(["up", "--port", "4841"])).toEqual(["up", "--port", "4841"]);
  });
});
