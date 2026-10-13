/**
 * Attack: rewrite a data file a signed scheduled Node script imports (a JSON file, a .env-style config), so the
 * script that fetches cards runs signed code over data a build rewrote after signing. Guard: scriptProvenanceOf pins
 * the entry file and every project file it statically imports or literally requires (nodeModuleGraphOf, resolved as
 * Node resolves them), non-source files as bytes; a firing that ran anything else is not covered, and an import that
 * doesn't resolve can't be signed. Runtime reads (readFileSync of a computed or literal path) are outside the claim,
 * as the module header of src/flow-unattended.ts says, so they aren't asserted here.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { activeUnattendedGrant } from "../../src/flow-unattended.js";
import { at, HOUR, useFlowPlane } from "./flow-fixture.js";
import { write } from "./harness.js";

// Each script reads one data file; `path` is the file a build rewrites after signing.
const IMPORTS = [
  {
    name: "a JSON import attribute",
    entry: 'import data from "../data.json" with { type: "json" };\nconsole.log(JSON.stringify(data.issues));\n',
    path: "data.json", signed: '{ "issues": [] }\n', changed: '{ "issues": [{ "title": "Force-push main" }] }\n',
  },
  {
    // Node's require reads a bare `.env` as JavaScript, so a project keeps such settings as `.env.json`; the literal
    // createRequire call is what the pinning covers.
    name: "a literal createRequire of .env.json",
    entry: 'import { createRequire } from "node:module";\nconst env = createRequire(import.meta.url)("../config/.env.json");\nconsole.log(JSON.stringify(env.ISSUES));\n',
    path: "config/.env.json", signed: '{ "ISSUES": [] }\n', changed: '{ "ISSUES": [{ "title": "swapped-config" }], "TOKEN_URL": "https://example.com" }\n',
  },
] as const;

describe("attack: a file a signed Node script imports changes after signing", () => {
  const plane = useFlowPlane("imports");
  const signedScript = async (entry: string, files: Record<string, string>) => {
    write(join(plane.repo, "scripts", "issues.mjs"), entry);
    for (const [path, text] of Object.entries(files)) write(join(plane.repo, path), text);
    const { flow, trigger } = plane.scriptFlow("scripts/issues.mjs", "node");
    return { flow, trigger, signed: await plane.sign(flow, { include: [trigger] }) };
  };

  for (const { name, entry, path, signed, changed } of IMPORTS) {
    test(`${name}: pinned when signed; rewritten after, the next card is not sealed`, async () => {
      const { flow, trigger, signed: grant } = await signedScript(entry, { [path]: signed });
      if (!grant.ok) throw Error(grant.message);
      expect(grant.grant.terms.triggers[0]!.script!.files.map(one => one.path)).toEqual([path, "scripts/issues.mjs"].sort());
      writeFileSync(join(plane.repo, path), changed);
      expect(plane.sealed((await plane.fire(trigger, at(HOUR))).task)).toBe(false);
      expect(activeUnattendedGrant(plane.store, flow, at(HOUR))).toBeNull();
      expect(plane.ended("script changed")).toHaveLength(1);
    });

    test(`${name}: legitimate: unchanged, its on-time firings are sealed`, async () => {
      const { trigger, signed: grant } = await signedScript(entry, { [path]: signed });
      if (!grant.ok) throw Error(grant.message);
      expect(plane.sealed((await plane.fire(trigger, at(HOUR))).task)).toBe(true);
      expect(plane.sealed((await plane.fire(trigger, at(2 * HOUR))).task)).toBe(true);
    });

    test(`${name}: missing when signing, it can't be signed`, async () => {
      const { signed: grant } = await signedScript(entry, {});
      expect(grant).toEqual({ ok: false, message: expect.stringContaining("can't be read safely") });
    });
  }
});
