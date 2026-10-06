import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseProof, serializeProof } from "../proof.js";
import { TEXT_LIMITS } from "../text-limits.js";
import { assertContract, type SampleVerdict } from "./contract-test.js";
import { PROOF_COUNTS, PROOF_LIMITS, proofSchema } from "./proof.js";
import { adjudications, evidenceBaseline, evidenceSamples } from "../../test/evidence-replay.js";

const read = (input: unknown): SampleVerdict => {
  const parsed = parseProof(JSON.stringify(input));
  return parsed.ok ? { ok: true } : { ok: false, lines: parsed.problems.map(problem => problem.message) };
};

const criterion = { id: "c1", statement: "The settings panel opens.", how: "Clicked it in the demo build.", verdict: "met", evidence: [{ kind: "check", ref: "npm test" }] };
const current = {
  version: 2,
  criteria: [criterion],
  checks: [{ command: "npm test", summary: "12 passed", exitCode: 0 }],
  changed: ["src/x.ts"],
  caveats: [],
  screenshots: [{ path: "evidence/panel.png", caption: "The panel open." }],
};
const { version: _version, ...lists } = current;
const savedProofs = evidenceSamples.flatMap(sample => (sample.proof === null ? [] : [{ name: `${sample.run}/proof.json`, input: JSON.parse(sample.proof) as unknown }]));

describe("the proof contract", () => {
  it("holds: the JSON Schema round trip loses nothing, saved and current proofs read, malformed ones are refused by path", () => {
    expect(savedProofs.length).toBeGreaterThanOrEqual(10);
    assertContract({
      schema: proofSchema,
      read,
      valid: [
        ...savedProofs,
        { name: "current version 2", input: current },
        { name: "what a builder writes: version 1, screenshots only", input: { version: 1, screenshots: current.screenshots } },
        { name: "version 1 with every list and evidence", input: { version: 1, ...lists } },
        { name: "version 1 ignores unknown keys and reads null lists as empty", input: { version: 1, notes: "x", criteria: [{ ...criterion, evidence: null, extra: 1 }], checks: null, caveats: null } },
        { name: "pending-verification on a check criterion", input: { ...current, criteria: [{ ...criterion, verdict: "pending-verification" }] } },
      ],
      invalid: [
        { name: "newer version", input: { ...current, version: 3 }, paths: ["version"] },
        { name: "no version", input: lists, paths: ["version"] },
        { name: "version 2 is strict", input: { ...current, notes: "x" }, paths: ["payload"] },
        { name: "version 2 has every list", input: { version: 2, criteria: [], checks: [], changed: [], caveats: [] }, paths: ["screenshots"] },
        { name: "unknown criterion key", input: { ...current, criteria: [{ ...criterion, extra: 1 }] }, paths: ["criteria[0]"] },
        { name: "bad verdict", input: { ...current, criteria: [{ ...criterion, verdict: "sort-of" }] }, paths: ["criteria[0].verdict"] },
        { name: "bad evidence kind", input: { ...current, criteria: [{ ...criterion, evidence: [{ kind: "vibes", ref: "x" }] }] }, paths: ["criteria[0].evidence[0].kind"] },
        { name: "exit code out of range", input: { ...current, checks: [{ ...current.checks[0], exitCode: 256 }] }, paths: ["checks[0].exitCode"] },
        { name: "too many criteria", input: { version: 1, criteria: Array.from({ length: PROOF_COUNTS.criteria + 1 }, (_, i) => ({ ...criterion, id: `c${i}` })) }, paths: ["criteria"] },
        { name: "blank how", input: { ...current, criteria: [{ ...criterion, how: "   " }] }, paths: ["criteria[0].how"] },
        { name: "caveat over its UTF-8 byte limit", input: { ...current, caveats: ["é".repeat(TEXT_LIMITS.proofLineBytes / 2 + 1)] }, paths: ["caveats[0]"] },
        { name: "control characters", input: { ...current, changed: ["src/\u001b[2Jx.ts"] }, paths: ["changed[0]"] },
        { name: "absolute screenshot path", input: { ...current, screenshots: [{ path: "/etc/passwd", caption: "c" }] }, paths: ["screenshots[0].path"] },
        { name: "duplicate criterion id", input: { ...current, criteria: [criterion, criterion] }, paths: ["criteria[1].id"] },
        { name: "duplicate screenshot path", input: { ...current, screenshots: [current.screenshots[0], current.screenshots[0]] }, paths: ["screenshots[1].path"] },
      ],
    });
  });

  it("takes its byte limits from TEXT_LIMITS", () => {
    expect(PROOF_LIMITS).toMatchObject({ payload: TEXT_LIMITS.proofPayloadBytes, criterionId: TEXT_LIMITS.proofCriterionIdBytes, criterionHow: TEXT_LIMITS.proofHowBytes, caveat: TEXT_LIMITS.proofLineBytes });
    expect(parseProof("x".repeat(PROOF_LIMITS.payload + 1))).toEqual({ ok: false, problems: [{ reason: "too-large", message: "payload: over 65,536 bytes" }] });
  });

  it("names the path in every refusal and keeps the reason codes", () => {
    const problems = (input: unknown) => {
      const parsed = parseProof(JSON.stringify(input));
      return parsed.ok ? [] : parsed.problems.map(problem => [problem.reason, problem.message]);
    };
    expect(problems({ ...current, version: 3 })).toEqual([["newer-version", "version: made by a newer Toolroll (version 3; this one reads up to 2)"]]);
    expect(problems({ version: 1, criteria: [{ id: "c1", statement: "", verdict: "met" }] })).toEqual([
      ["missing-criteria[0].statement", "criteria[0].statement: must not be empty"],
      ["missing-criteria[0].how", "criteria[0].how: required"],
    ]);
    expect(problems({ ...current, notes: "x" })).toEqual([["payload-unknown-key", "payload: unknown key 'notes'"]]);
    expect(problems({ ...current, screenshots: [{ path: "a/../b.png", caption: "c" }] })).toEqual([["screenshots[0].path-not-relative", "screenshots[0].path: must be a normalized repository-relative path"]]);
  });

  it("stores version 2 and reads it back unchanged", () => {
    const parsed = parseProof(JSON.stringify({ version: 1, screenshots: current.screenshots, extra: true }));
    expect(parsed).toEqual({ ok: true, proof: { version: 2, criteria: [], checks: [], changed: [], caveats: [], screenshots: current.screenshots } });
    if (!parsed.ok) return;
    expect(parseProof(serializeProof(parsed.proof))).toEqual(parsed);
  });
});

describe("the replayed evidence samples", () => {
  it("read as before: every saved proof's content, upgraded from version 1 to version 2", () => {
    for (const sample of evidenceSamples) {
      const before = evidenceBaseline[sample.run]!.proof;
      if (sample.proof === null) {
        expect(before).toBeNull();
        continue;
      }
      expect(before, sample.run).toMatchObject({ ok: true, proof: { version: 1 } });
      const now = parseProof(sample.proof);
      expect(now, sample.run).toEqual(before === null || !before.ok ? before : { ok: true, proof: { ...before.proof, version: 2 } });
    }
  });

  it("adjudicate exactly as before: verdict, reasons, matrix and machine verdict, under every recorded set of facts", () => {
    let compared = 0;
    for (const sample of evidenceSamples) {
      const results = adjudications(sample.proof === null ? null : parseProof(sample.proof), sample.receipt);
      expect(results, sample.run).toEqual(evidenceBaseline[sample.run]!.adjudication);
      compared += Object.keys(results).length;
    }
    expect(compared).toBe(evidenceSamples.length * 5);
  });
});

describe("docs/plans/zod-revamp.md", () => {
  it("marks wave 1 item 6 done", () => {
    const doc = readFileSync(new URL("../../docs/plans/zod-revamp.md", import.meta.url), "utf8");
    expect(doc).toMatch(/^\| 6 ✅ \| \*\*Builder handoff and proof\*\*/m);
    expect(doc.slice(doc.indexOf("## Done"))).toContain("**6. Builder handoff and proof**");
  });
});
