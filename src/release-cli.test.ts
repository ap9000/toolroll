import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { main } from "./cli.js";
import { LEASE_DEPRECATION, runReleaseCommand } from "./release-cli.js";
import type { ReleaseAdapters } from "./release.js";

const LEASE = "0b6f3a8e-2c1d-4e5f-9a7b-1c2d3e4f5a6b";

/** Adapters that stop the release at its first check: gh is signed out. */
const signedOut = { github: { authenticated: async () => false } } as unknown as ReleaseAdapters;

describe("toolroll release <branch>", () => {
  test("a lease-shaped value is the old lease form: it warns once and returns the lease as `worker release`", async () => {
    const warned: string[] = [], handed: (readonly string[])[] = [];
    const code = await runReleaseCommand([LEASE, "--json"], () => {}, { warn: line => warned.push(line), releaseLease: async args => { handed.push(args); return 0; } });
    expect(code).toBe(0);
    expect(warned).toEqual([LEASE_DEPRECATION]);
    expect(handed).toEqual([[LEASE, "--json"]]);
  });

  test("a lease-shaped value with release options is refused as ambiguous, never guessed", async () => {
    const lines: string[] = [];
    const code = await runReleaseCommand([LEASE, "--repo", "/rv", "--json"], line => lines.push(line), { releaseLease: async () => { throw new Error("guessed"); } });
    expect(code).toBe(2);
    expect(JSON.parse(lines.join("\n"))).toMatchObject({ ok: false, command: "release", reason: "ambiguous" });
  });

  test("usage slips answer with one envelope", async () => {
    for (const argv of [[], ["a", "b"], ["main..x"], ["b", "--limit", "nap=5"], ["b", "--frobnicate"], ["b", "--repo"]]) {
      const lines: string[] = [];
      expect(await runReleaseCommand([...argv, "--json"], line => lines.push(line)), argv.join(" ")).toBe(2);
      expect(JSON.parse(lines.join("\n")), argv.join(" ")).toMatchObject({ ok: false, command: "release", reason: "usage" });
    }
  });

  test("a stop names its step and the command that continues from it", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "so-release-cli-"));
    const lines: string[] = [];
    expect(await runReleaseCommand(["toolroll/simplify-release", "--repo", "/rv"], line => lines.push(line), { adapters: signedOut, stateDir })).toBe(3);
    expect(lines).toEqual([
      "✗ Stopped at preflight: GitHub CLI is not signed in: run `gh auth login`, then rerun.",
      "  Continue from there: toolroll release toolroll/simplify-release --repo /rv",
    ]);
    lines.length = 0;
    expect(await runReleaseCommand(["toolroll/simplify-release", "--repo", "/rv", "--json"], line => lines.push(line), { adapters: signedOut, stateDir })).toBe(3);
    expect(JSON.parse(lines.join("\n"))).toMatchObject({ ok: false, command: "release", reason: "github-auth", step: "preflight", resume: "toolroll release toolroll/simplify-release --repo /rv" });
  });

  test("--release-gate shows the proof, lifts only with --yes, and takes no release options", async () => {
    const lines: string[] = [];
    const world = { database: "/s/orders.db", stateDir: "/s", now: () => new Date(), open: () => { throw new Error("not opened in this test"); }, servicePlists: () => [], processes: () => [] };
    expect(await runReleaseCommand(["--release-gate", LEASE, "--json"], line => lines.push(line), { gateWorld: world })).toBe(3);
    expect(JSON.parse(lines.join("\n"))).toMatchObject({ ok: false, command: "release", reason: "error", message: expect.stringContaining("left as it is") });
    for (const argv of [["b", "--release-gate", LEASE], ["--release-gate", LEASE, "--new"], ["--release-gate"], ["b", "--yes"]]) {
      lines.length = 0;
      expect(await runReleaseCommand([...argv, "--json"], line => lines.push(line), { gateWorld: world }), argv.join(" ")).toBe(2);
      expect(JSON.parse(lines.join("\n")), argv.join(" ")).toMatchObject({ ok: false, reason: "usage" });
    }
  });

  test("the binary routes `release` to the release and `worker release` to the lease", async () => {
    const lines: string[] = [];
    expect(await main(["release", "--help"], line => lines.push(line))).toBe(0);
    expect(lines.join("\n")).toMatch(/^toolroll release <branch>/);
    lines.length = 0;
    const db = join(mkdtempSync(join(tmpdir(), "so-release-cli-")), "orders.db");
    expect(await main(["worker", "release", "--json"], line => lines.push(line), { operate: { databaseFile: db } })).toBe(2);
    expect(JSON.parse(lines.join("\n"))).toMatchObject({ ok: false, command: "worker release", reason: "usage" });
    lines.length = 0;
    expect(await main(["release", LEASE, "--json"], line => lines.push(line), { operate: { databaseFile: db }, release: { warn: () => {} } })).toBe(3);
    expect(JSON.parse(lines.join("\n"))).toMatchObject({ ok: false, command: "worker release", message: "no such lease" });
  });
});
