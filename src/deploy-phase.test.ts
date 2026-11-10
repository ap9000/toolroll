/**
 * One table for a deployment journal's phases (docs/plans/deploy-phase-table.md): the runtime (deploy-phase.ts) and
 * the deploy scripts (scripts/deploy-phase-table.mjs) read one data file, answer alike for every word, and no
 * script journals a word the table does not hold.
 */
import { describe, expect, test } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import * as typed from "./deploy-phase.js";
import * as script from "../scripts/deploy-phase-table.mjs";
import { BEFORE_SWAP as GATE_BEFORE_SWAP } from "./release-gate.js";
import { FORWARD_ONLY as RESCUE_FORWARD_ONLY } from "./deploy-rescue.js";
import { deployActionOf as nextActionOf } from "./release-next.js";
import { MIGRATION_STARTED as RECOVERY_MIGRATION_STARTED, PAUSED_BEFORE_SWAP as RECOVERY_PAUSED } from "../scripts/deploy-recovery.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

/** Written by hand, in journal order: what a stopped deployment at each phase calls for. A change to the data file
 * that is not made here too fails. */
const EXPECTED: readonly (readonly [string, string])[] = [
  ["preparing", "lift-pause"],
  ["admission-paused", "lift-pause"],
  ["frozen", "lift-pause"],
  ["backup-verified", "lift-pause"],
  ["rehearsed", "lift-pause"],
  ["stopping", "roll-back"],
  ["stopped", "roll-back"],
  ["migrating", "roll-back"],
  ["migrated", "roll-back"],
  ["starting", "forward"],
  ["started", "forward"],
  ["healthy", "forward"],
  ["start-failed", "roll-back"],
  ["backup-restored", "roll-back"],
  ["restored", "roll-back"],
  ["released", "none"],
  ["deployed", "none"],
];
const NOT_PHASES: readonly unknown[] = ["no-such-phase", "", "Starting", "starting ", "__proto__", "constructor", "toString", undefined, null, 7, true, {}, ["starting"]];

describe("the deployment phase table", () => {
  test("holds exactly the 17 phases, in journal order, each with one action", () => {
    expect(typed.DEPLOY_PHASES).toEqual(EXPECTED.map(([phase]) => phase));
    for (const [phase, action] of EXPECTED) expect([phase, typed.deployActionOf(phase)]).toEqual([phase, action]);
  });

  test("derives the lists the files used to keep by hand", () => {
    expect(typed.BEFORE_SWAP).toEqual(["preparing", "admission-paused", "frozen", "backup-verified", "rehearsed"]);
    expect(typed.PAUSED_BEFORE_SWAP).toEqual(["admission-paused", "frozen", "backup-verified", "rehearsed"]);
    expect(typed.MIGRATION_STARTED).toEqual(["migrating", "migrated", "start-failed"]);
    expect(typed.RESTARTABLE).toEqual(["stopped", "migrating", "migrated", "start-failed", "backup-restored"]);
    expect(typed.FORWARD_ONLY).toEqual(["starting", "started", "healthy"]);
    expect(typed.NEEDS_NO_RECOVERY).toEqual(["released", "deployed"]);
    expect(typed.RELEASED).toBe("released");
    // Only a deployment that finished installed its runtime; one whose pause was lifted did not.
    expect(typed.DEPLOY_PHASES.filter(phase => typed.isDeployed(phase))).toEqual(["deployed"]);
    expect(typed.DEPLOY_PHASES.filter(phase => typed.stoppedWhereNothingChanged(phase))).toEqual(["preparing", "released", "deployed"]);
    // "starting" is in no list recovery acts on: a journal alone never rolls a service back from there.
    for (const list of [typed.BEFORE_SWAP, typed.MIGRATION_STARTED, typed.RESTARTABLE, typed.NEEDS_NO_RECOVERY]) expect(list).not.toContain("starting");
  });

  test("the runtime and the deploy scripts answer alike, for every phase and for anything that is not one", () => {
    expect(script.DEPLOY_PHASES).toEqual(typed.DEPLOY_PHASES);
    for (const name of ["BEFORE_SWAP", "PAUSED_BEFORE_SWAP", "MIGRATION_STARTED", "RESTARTABLE", "FORWARD_ONLY", "NEEDS_NO_RECOVERY"] as const) expect([name, script[name]]).toEqual([name, typed[name]]);
    for (const word of [...typed.DEPLOY_PHASES, ...NOT_PHASES]) {
      expect([word, script.deployActionOf(word)]).toEqual([word, typed.deployActionOf(word)]);
      expect([word, script.isDeployPhase(word)]).toEqual([word, typed.isDeployPhase(word)]);
      expect([word, script.isDeployed(word)]).toEqual([word, typed.isDeployed(word)]);
      expect([word, script.stoppedWhereNothingChanged(word)]).toEqual([word, typed.stoppedWhereNothingChanged(word)]);
    }
    // The names other files import are the table's own lists, not copies.
    expect(GATE_BEFORE_SWAP).toBe(typed.BEFORE_SWAP);
    expect(RESCUE_FORWARD_ONLY).toBe(typed.FORWARD_ONLY);
    expect(nextActionOf).toBe(typed.deployActionOf);
    expect(RECOVERY_PAUSED).toBe(script.PAUSED_BEFORE_SWAP);
    expect(RECOVERY_MIGRATION_STARTED).toBe(script.MIGRATION_STARTED);
  });

  test("a word that is not a phase has no action: it is refused, never rolled back, and never journaled", () => {
    for (const word of NOT_PHASES) {
      expect([word, typed.deployActionOf(word)]).toEqual([word, "refuse"]);
      expect([word, typed.isDeployPhase(word), typed.isDeployed(word), typed.stoppedWhereNothingChanged(word)]).toEqual([word, false, false, false]);
      expect(() => script.assertDeployPhase(word)).toThrow("is not a deployment phase; the journal was not written.");
      expect(() => typed.assertDeployPhase(word as string)).toThrow("is not a deployment phase; the journal was not written.");
    }
    for (const phase of typed.DEPLOY_PHASES) expect(script.assertDeployPhase(phase)).toBe(phase);
  });

  test("a damaged data file is refused whole, the same way on both sides", () => {
    const good = { phase: "preparing", action: "lift-pause", flags: ["beforeSwap"] };
    const bad: readonly (readonly [unknown, string])[] = [
      [null, "has no rows"],
      [{ phases: [] }, "has no rows"],
      [{ phases: [good, good] }, "bad or repeated phase"],
      [{ phases: [{ ...good, phase: "Bad Word" }] }, "bad or repeated phase"],
      [{ phases: [{ ...good, action: "refuse" }] }, "has no known action"],
      [{ phases: [{ phase: "preparing", flags: [] }] }, "has no known action"],
      [{ phases: [{ ...good, flags: ["trusted"] }] }, "unknown or repeated flag"],
      [{ phases: [{ ...good, flags: ["beforeSwap", "beforeSwap"] }] }, "unknown or repeated flag"],
    ];
    for (const [data, words] of bad) {
      expect(() => typed.deployPhaseRows(data)).toThrow(words);
      expect(() => script.deployPhaseRows(data)).toThrow(words);
    }
    expect(typed.deployPhaseRows({ phases: [good] })).toEqual(script.deployPhaseRows({ phases: [good] }));
  });
});

describe("what the code journals", () => {
  /** Every phase word written as a literal where a journal is written: save(r, "…"), mark("…"), and the new
   * journal's own `phase: "…"`. */
  const written = (): { word: string; file: string }[] => {
    const files = [
      ...readdirSync(join(root, "scripts")).filter(name => /^deploy-.*\.mjs$/.test(name)).map(name => join("scripts", name)),
      join("src", "release-gate.ts"), join("src", "deploy-rescue.ts"), join("src", "release-next.ts"), join("src", "release-adapters.ts"),
    ];
    const found: { word: string; file: string }[] = [];
    for (const file of files) {
      const text = readFileSync(join(root, file), "utf8");
      for (const match of text.matchAll(/\bsave\(\s*\w+\s*,\s*"([^"]*)"\s*\)|\bmark\(\s*"([^"]*)"\s*\)|\bphase:\s*"([^"]*)"\s*,\s*schema\b/g)) found.push({ word: (match[1] ?? match[2] ?? match[3])!, file });
    }
    return found;
  };

  test("only table words, and every table word has a writer", () => {
    const words = written();
    // The scan sees the writers it is meant to: the scripts' own, in three files.
    expect(new Set(words.map(one => one.file))).toEqual(new Set(["scripts/deploy-browser.mjs", "scripts/deploy-phases.mjs", "scripts/deploy-recovery.mjs"].map(file => join(...file.split("/")))));
    for (const { word, file } of words) expect([file, word, typed.isDeployPhase(word)]).toEqual([file, word, true]);
    // "released" is also written by the runtime's own pause release, through the table's constant.
    expect(readFileSync(join(root, "src", "release-gate.ts"), "utf8")).toContain("phase: RELEASED,");
    expect([...new Set(words.map(one => one.word))].sort()).toEqual([...typed.DEPLOY_PHASES].sort());
  });

  test("the journal writers themselves check the word (no literal is trusted to the scan alone)", () => {
    const phases = readFileSync(join(root, "scripts", "deploy-phases.mjs"), "utf8");
    expect(phases).toMatch(/const save = \(r, phase\) => \{ assertLocked\(\); assertDeployPhase\(phase\); r\.phase = phase;/);
    expect(phases).toMatch(/mark: phase => \{ assertDeployPhase\(phase\); r\.phase = phase;/);
    // No other assignment of a journal's phase in the scripts.
    const assigned = [...phases.matchAll(/\br\.phase = /g)].length;
    expect(assigned).toBe(2);
  });

  test("the build carries the data file beside the module that reads it", () => {
    expect(readFileSync(join(root, "scripts", "postbuild.mjs"), "utf8")).toContain('resolve(root, "src", "deploy-phase-data.json"), resolve(root, "dist", "deploy-phase-data.json")');
    // The suite's global setup builds dist before any test runs.
    expect(existsSync(join(root, "dist", "deploy-phase.js"))).toBe(true);
    expect(readFileSync(join(root, "dist", "deploy-phase-data.json"), "utf8")).toBe(readFileSync(join(root, "src", "deploy-phase-data.json"), "utf8"));
  });
});
