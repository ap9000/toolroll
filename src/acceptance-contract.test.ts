/**
 * Acceptance Contract v2 (v39): the rubric's own digest behavior
 * (grandfathering, canonicalization) and the adjudicator's new rules for a
 * signed rubric. Deliberately a NEW file, not an edit to scope.test.ts or
 * proof.test.ts — those two passing byte for byte unmodified is the
 * grandfathering proof; any need to touch them would mean the digest rule
 * leaked into the pre-v39 golden values.
 */
import { describe, test, expect } from "vitest";
import {
  digestOf,
  parseAcceptanceCriteria,
  acceptanceLinesToInput,
  acceptanceToLines,
  proposeGuarded,
  propose,
  type AcceptanceCriterion,
} from "./scope.js";
import { openStore, type Store } from "./store.js";
import { adjudicate, type AdjudicateInput, type ApprovedCriterion, parseProof, PROOF_LIMITS } from "./proof.js";
import { imageDimensions, validateScreenshotBytes } from "./evidence.js";

const T0 = new Date("2026-09-07T00:00:00.000Z");

// ---------------------------------------------------------------- digest

describe("digestOf: the rubric folds in only when non-empty (v39)", () => {
  const bare = { goal: "a guard", outOfScope: null, touches: [] as string[] };
  const GOLDEN = "a24c72e6603f78291e1eea2e162b383e"; // scope.test.ts's own golden value

  test("absent acceptance digests to the exact pre-v39 golden value", () => {
    expect(digestOf(bare)).toBe(GOLDEN);
  });

  test("an explicitly empty rubric digests identically to absent", () => {
    expect(digestOf({ ...bare, acceptance: [] })).toBe(GOLDEN);
  });

  test("a non-empty rubric moves the digest away from the golden value", () => {
    const acceptance: AcceptanceCriterion[] = [{ id: "c1", statement: "it guards", how: null, evidence: ["manual-review"] }];
    expect(digestOf({ ...bare, acceptance })).not.toBe(GOLDEN);
  });

  test("criterion order is presentation, not meaning", () => {
    const a: AcceptanceCriterion[] = [
      { id: "c1", statement: "first", how: null, evidence: ["check"] },
      { id: "c2", statement: "second", how: null, evidence: ["manual-review"] },
    ];
    const b = [...a].reverse();
    expect(digestOf({ ...bare, acceptance: a })).toBe(digestOf({ ...bare, acceptance: b }));
  });

  test("evidence kind order within one criterion is presentation, not meaning", () => {
    const a: AcceptanceCriterion[] = [{ id: "c1", statement: "s", how: null, evidence: ["check", "screenshot"] }];
    const b: AcceptanceCriterion[] = [{ id: "c1", statement: "s", how: null, evidence: ["screenshot", "check"] }];
    expect(digestOf({ ...bare, acceptance: a })).toBe(digestOf({ ...bare, acceptance: b }));
  });

  test("`how` is advisory and never enters the digest", () => {
    const a: AcceptanceCriterion[] = [{ id: "c1", statement: "s", how: "check it by hand", evidence: ["check"] }];
    const b: AcceptanceCriterion[] = [{ id: "c1", statement: "s", how: null, evidence: ["check"] }];
    const c: AcceptanceCriterion[] = [{ id: "c1", statement: "s", how: "a totally different note", evidence: ["check"] }];
    expect(digestOf({ ...bare, acceptance: a })).toBe(digestOf({ ...bare, acceptance: b }));
    expect(digestOf({ ...bare, acceptance: a })).toBe(digestOf({ ...bare, acceptance: c }));
  });

  test("a statement edit moves the digest — voids the approval it would otherwise carry", () => {
    const a: AcceptanceCriterion[] = [{ id: "c1", statement: "the original claim", how: null, evidence: ["check"] }];
    const b: AcceptanceCriterion[] = [{ id: "c1", statement: "a rewritten claim", how: null, evidence: ["check"] }];
    expect(digestOf({ ...bare, acceptance: a })).not.toBe(digestOf({ ...bare, acceptance: b }));
  });

  test("an evidence-kind edit moves the digest — it is signed, unlike how", () => {
    const a: AcceptanceCriterion[] = [{ id: "c1", statement: "s", how: null, evidence: ["check"] }];
    const b: AcceptanceCriterion[] = [{ id: "c1", statement: "s", how: null, evidence: ["manual-review"] }];
    expect(digestOf({ ...bare, acceptance: a })).not.toBe(digestOf({ ...bare, acceptance: b }));
  });
});

// ---------------------------------------------------------- parsing / CLI text

describe("parseAcceptanceCriteria: fail closed, every problem at once", () => {
  test("absent or empty input parses to [] with no problems — the primitive's own permission", () => {
    expect(parseAcceptanceCriteria(undefined)).toEqual({ criteria: [], problems: [] });
    expect(parseAcceptanceCriteria([])).toEqual({ criteria: [], problems: [] });
  });

  test("duplicate ids are refused", () => {
    const result = parseAcceptanceCriteria([
      { id: "c1", statement: "a", evidence: ["check"] },
      { id: "c1", statement: "b", evidence: ["check"] },
    ]);
    expect(result.problems.some(p => p.reason.includes("duplicate-id"))).toBe(true);
  });

  test("an evidence kind outside the four is refused", () => {
    const result = parseAcceptanceCriteria([{ id: "c1", statement: "a", evidence: ["vibes"] }]);
    expect(result.problems.some(p => p.reason.includes("bad-evidence-kind"))).toBe(true);
  });

  test("an empty evidence array is refused — every criterion needs at least one required kind", () => {
    const result = parseAcceptanceCriteria([{ id: "c1", statement: "a", evidence: [] }]);
    expect(result.problems.length).toBeGreaterThan(0);
  });

  test("a well-formed rubric round-trips through the CLI/textarea line encoding", () => {
    const criteria: AcceptanceCriterion[] = [
      { id: "c1", statement: "The button opens the panel", how: "click it", evidence: ["screenshot"] },
      { id: "c2", statement: "The suite passes", how: null, evidence: ["check", "changed-path"] },
    ];
    const lines = acceptanceToLines(criteria);
    const parsed = parseAcceptanceCriteria(acceptanceLinesToInput(lines));
    expect(parsed.problems).toEqual([]);
    expect(parsed.criteria).toEqual(criteria);
  });

  test("an id-less line auto-numbers", () => {
    const input = acceptanceLinesToInput(["The suite passes | check", "Docs are updated | manual-review"]);
    const parsed = parseAcceptanceCriteria(input);
    expect(parsed.problems).toEqual([]);
    expect(parsed.criteria.map(c => c.id)).toEqual(["c1", "c2"]);
  });
});

// ------------------------------------------------------------ mandatory gate

describe("proposeGuarded: the rubric is mandatory on this road, never on the bare primitive", () => {
  let store: Store;
  const seed = () => {
    store = openStore(":memory:");
    store.createTask({ id: "t-1", title: "x" }, T0);
    return store;
  };

  test("propose() (the primitive) accepts an empty rubric — grandfathered fixtures and internal callers are untouched", () => {
    seed();
    const scope = propose(store, { taskId: "t-1", goal: "a guard", now: T0 });
    expect(scope.acceptance).toEqual([]);
    store.close();
  });

  test("proposeGuarded refuses an empty rubric with a clear reason", () => {
    seed();
    const result = proposeGuarded(store, { taskId: "t-1", goal: "a guard", sawDigest: null, taskRef: null, now: T0 });
    expect(result).toMatchObject({ ok: false, reason: "acceptance-required" });
    store.close();
  });

  test("proposeGuarded refuses a malformed rubric", () => {
    seed();
    const result = proposeGuarded(store, {
      taskId: "t-1", goal: "a guard", acceptance: [{ id: "c1", statement: "s", evidence: ["not-a-kind"] }],
      sawDigest: null, taskRef: null, now: T0,
    });
    expect(result).toMatchObject({ ok: false, reason: "bad-acceptance" });
    store.close();
  });

  test("proposeGuarded accepts a well-formed rubric and it lands on the scope", () => {
    seed();
    const result = proposeGuarded(store, {
      taskId: "t-1", goal: "a guard",
      acceptance: [{ id: "c1", statement: "it guards", evidence: ["manual-review"] }],
      sawDigest: null, taskRef: null, now: T0,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.scope.acceptance).toEqual([{ id: "c1", statement: "it guards", how: null, evidence: ["manual-review"] }]);
    store.close();
  });
});

// ------------------------------------------ parseProof: criterion evidence

describe("parseProof: a criterion's typed evidence refs (v39) — fail closed, byte-capped, kind-checked", () => {
  const withEvidence = (evidence: unknown) => ({
    version: 1,
    criteria: [{ id: "c1", statement: "s", verdict: "met", how: "h", evidence }],
    checks: [], changed: [], caveats: [], screenshots: [],
  });
  const problemsOf = (evidence: unknown): string[] => {
    const result = parseProof(JSON.stringify(withEvidence(evidence)));
    return result.ok ? [] : result.problems.map(p => p.reason);
  };

  test("absent evidence parses to [] — a criterion the agent added beyond the rubric", () => {
    const result = parseProof(JSON.stringify(withEvidence(undefined)));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.proof.criteria[0]?.evidence).toEqual([]);
  });

  test("must be an array", () => {
    expect(problemsOf("nope")).toContain("bad-criteria[0].evidence");
  });

  test("caps at PROOF_LIMITS.evidencePerCriterion entries", () => {
    const many = Array.from({ length: PROOF_LIMITS.evidencePerCriterion + 1 }, () => ({ kind: "check", ref: "npm test" }));
    expect(problemsOf(many)).toContain("criteria[0].evidence-too-many");
  });

  test("kind must draw from the four signed kinds", () => {
    expect(problemsOf([{ kind: "vibes", ref: "x" }])).toContain("bad-criteria[0].evidence[0].kind");
  });

  test("ref is required prose, capped at PROOF_LIMITS.evidenceRef bytes, control-free", () => {
    expect(problemsOf([{ kind: "check", ref: "" }])).toContain("missing-criteria[0].evidence[0].ref");
    expect(problemsOf([{ kind: "check", ref: "x".repeat(PROOF_LIMITS.evidenceRef + 1) }])).toContain(
      "criteria[0].evidence[0].ref-too-long",
    );
    expect(problemsOf([{ kind: "check", ref: "look\x1b]0;pwned\x07" }])).toContain("criteria[0].evidence[0].ref-controls");
  });

  test("a non-object entry is refused", () => {
    expect(problemsOf(["not-an-object"])).toContain("bad-criteria[0].evidence[0]");
  });

  test("a sound multi-kind evidence list round-trips exactly", () => {
    const sound = [
      { kind: "check", ref: "npm test" },
      { kind: "screenshot", ref: "e/a.png" },
      { kind: "changed-path", ref: "src/x.ts" },
      { kind: "manual-review", ref: "a human looked" },
    ];
    const result = parseProof(JSON.stringify(withEvidence(sound)));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.proof.criteria[0]?.evidence).toEqual(sound);
  });
});

// ------------------------------------------------------------- adjudication

const APPROVED: ApprovedCriterion[] = [{ id: "c1", statement: "The button opens the settings panel.", evidence: ["screenshot"] }];

function baseInput(overrides: Partial<AdjudicateInput> = {}): AdjudicateInput {
  return {
    proofArtifactPresent: true,
    proofParse: null,
    handoffPresent: true,
    terminalDiffPresent: true,
    terminalDiffCaptureStatus: "ok",
    diffStat: { captured: true, truncated: false, paths: new Set() },
    verifyCommand: { configured: false },
    screenshots: [],
    approvedCriteria: APPROVED,
    ...overrides,
  };
}

describe("adjudicate: approvedCriteria empty runs the v1 rules byte for byte", () => {
  test("empty approvedCriteria never triggers a rubric rule, whatever the proof says", () => {
    const proof = parseProof(JSON.stringify({ version: 1, criteria: [], checks: [], changed: [], caveats: [], screenshots: [] }));
    const result = adjudicate({ ...baseInput({ approvedCriteria: [] }), proofParse: proof });
    expect(result.verdict).toBe("attested");
    expect(result.matrix).toEqual([]);
  });
});

describe("adjudicate: the signed rubric's rules (v39)", () => {
  test("an unanswered approved criterion is short, and the matrix marks it missing", () => {
    const proof = parseProof(JSON.stringify({ version: 1, criteria: [], checks: [], changed: [], caveats: [], screenshots: [] }));
    const result = adjudicate({ ...baseInput(), proofParse: proof });
    expect(result.verdict).toBe("short");
    expect(result.reasons[0]).toContain('does not answer approved criterion "c1"');
    expect(result.matrix).toEqual([
      {
        id: "c1",
        statement: APPROVED[0]!.statement,
        requiredEvidence: ["screenshot"],
        state: "missing",
        detail: [expect.stringContaining("c1")],
        answered: [],
        review: null,
      },
    ]);
  });

  test("a proof that restates the criterion's statement is refuted, not short", () => {
    const proof = parseProof(
      JSON.stringify({
        version: 1,
        criteria: [{ id: "c1", statement: "A DIFFERENT claim entirely.", verdict: "met", how: "x", evidence: [{ kind: "screenshot", ref: "e/a.png" }] }],
        checks: [], changed: [], caveats: [],
        screenshots: [{ path: "e/a.png", caption: "c" }],
      }),
    );
    const result = adjudicate({
      ...baseInput(),
      proofParse: proof,
      screenshots: [{ path: "e/a.png", ok: true, bytes: 4096, dims: { width: 640, height: 480 } }],
    });
    expect(result.verdict).toBe("refuted");
    expect(result.reasons[0]).toContain("was signed as");
    expect(result.matrix[0]?.state).toBe("failed");
  });

  test("a screenshot reference that resolves, is real-sized, and matches the exact statement verifies", () => {
    const proof = parseProof(
      JSON.stringify({
        version: 1,
        criteria: [{ id: "c1", statement: APPROVED[0]!.statement, verdict: "met", how: "looked at it", evidence: [{ kind: "screenshot", ref: "e/a.png" }] }],
        checks: [], changed: [], caveats: [],
        screenshots: [{ path: "e/a.png", caption: "the panel" }],
      }),
    );
    const result = adjudicate({
      ...baseInput(),
      proofParse: proof,
      screenshots: [{ path: "e/a.png", ok: true, bytes: 4096, dims: { width: 640, height: 480 } }],
    });
    expect(result.verdict).toBe("attested");
    expect(result.matrix[0]?.state).toBe("pass");
  });

  test("a placeholder-sized screenshot (too small or under-dimensioned) cannot verify", () => {
    const proof = parseProof(
      JSON.stringify({
        version: 1,
        criteria: [{ id: "c1", statement: APPROVED[0]!.statement, verdict: "met", how: "x", evidence: [{ kind: "screenshot", ref: "e/tiny.png" }] }],
        checks: [], changed: [], caveats: [],
        screenshots: [{ path: "e/tiny.png", caption: "c" }],
      }),
    );
    const result = adjudicate({
      ...baseInput(),
      proofParse: proof,
      screenshots: [{ path: "e/tiny.png", ok: true, bytes: 90, dims: { width: 1, height: 1 } }],
    });
    expect(result.verdict).toBe("short");
    expect(result.matrix[0]?.state).toBe("failed");
    expect(result.matrix[0]?.detail[0]).toContain("placeholder-sized");
  });

  test("a check reference that resolves with exit 0 verifies; a nonzero exit fails the criterion", () => {
    const approvedCheck: ApprovedCriterion[] = [{ id: "c1", statement: "The suite passes.", evidence: ["check"] }];
    const passing = parseProof(
      JSON.stringify({
        version: 1,
        criteria: [{ id: "c1", statement: "The suite passes.", verdict: "met", how: "ran it", evidence: [{ kind: "check", ref: "npm test" }] }],
        checks: [{ command: "npm test", exitCode: 0, summary: "ok" }],
        changed: [], caveats: [], screenshots: [],
      }),
    );
    expect(adjudicate({ ...baseInput({ approvedCriteria: approvedCheck }), proofParse: passing }).verdict).toBe("attested");

    const failing = parseProof(
      JSON.stringify({
        version: 1,
        criteria: [{ id: "c1", statement: "The suite passes.", verdict: "met", how: "ran it", evidence: [{ kind: "check", ref: "npm test" }] }],
        checks: [{ command: "npm test", exitCode: 1, summary: "2 failed" }],
        changed: [], caveats: [], screenshots: [],
      }),
    );
    const result = adjudicate({ ...baseInput({ approvedCriteria: approvedCheck }), proofParse: failing });
    expect(result.verdict).toBe("short");
    expect(result.matrix[0]?.state).toBe("failed");
  });

  test("changed-path evidence requires the proof's changed[] to equal the sealed diff EXACTLY, not just a subset", () => {
    const approvedChanged: ApprovedCriterion[] = [{ id: "c1", statement: "Only src/x.ts changed.", evidence: ["changed-path"] }];
    const proof = parseProof(
      JSON.stringify({
        version: 1,
        criteria: [{ id: "c1", statement: "Only src/x.ts changed.", verdict: "met", how: "diff", evidence: [{ kind: "changed-path", ref: "src/x.ts" }] }],
        checks: [], changed: ["src/x.ts"], caveats: [], screenshots: [],
      }),
    );
    // The sealed diff ALSO touched src/y.ts, which the proof never claimed —
    // v1's subset check would have let this through; v39 must not.
    const result = adjudicate({
      ...baseInput({ approvedCriteria: approvedChanged }),
      proofParse: proof,
      diffStat: { captured: true, truncated: false, paths: new Set(["src/x.ts", "src/y.ts"]) },
    });
    expect(result.verdict).toBe("short");
    expect(result.matrix[0]?.state).toBe("failed");
    expect(result.matrix[0]?.detail[0]).toContain("do not exactly match");

    // Exact match verifies.
    const exact = adjudicate({
      ...baseInput({ approvedCriteria: approvedChanged }),
      proofParse: proof,
      diffStat: { captured: true, truncated: false, paths: new Set(["src/x.ts"]) },
    });
    expect(exact.verdict).toBe("attested");
    expect(exact.matrix[0]?.state).toBe("pass");
  });

  test("an unavailable or truncated diff cannot verify changed-path evidence, even if the claimed path is listed", () => {
    const approvedChanged: ApprovedCriterion[] = [{ id: "c1", statement: "Only src/x.ts changed.", evidence: ["changed-path"] }];
    const proof = parseProof(
      JSON.stringify({
        version: 1,
        criteria: [{ id: "c1", statement: "Only src/x.ts changed.", verdict: "met", how: "diff", evidence: [{ kind: "changed-path", ref: "src/x.ts" }] }],
        checks: [], changed: ["src/x.ts"], caveats: [], screenshots: [],
      }),
    );
    const truncated = adjudicate({
      ...baseInput({ approvedCriteria: approvedChanged }),
      proofParse: proof,
      diffStat: { captured: true, truncated: true, paths: new Set(["src/x.ts"]) },
    });
    expect(truncated.verdict).toBe("short");
    expect(truncated.matrix[0]?.detail[0]).toContain("unavailable or truncated");

    const unavailable = adjudicate({
      ...baseInput({ approvedCriteria: approvedChanged }),
      proofParse: proof,
      diffStat: { captured: false, truncated: false, paths: new Set() },
    });
    expect(unavailable.verdict).toBe("short");
  });

  describe("the changed[] vs. sealed-diff exactness check is GLOBAL (review finding), not tied to a changed-path criterion", () => {
    // None of these rubrics ask for changed-path evidence at all — a
    // rubric of pure screenshot/manual-review criteria must not let an
    // untruthful or unverifiable changed[] slip through just because
    // nothing in the signed matrix happens to cite it.
    const noChangedPathCriterion: ApprovedCriterion[] = [{ id: "c1", statement: "A human liked the copy.", evidence: ["manual-review"] }];
    const proofWith = (changed: string[]) =>
      parseProof(
        JSON.stringify({
          version: 1,
          criteria: [{ id: "c1", statement: "A human liked the copy.", verdict: "met", how: "read it", evidence: [{ kind: "manual-review", ref: "read it" }] }],
          checks: [], changed, caveats: [], screenshots: [],
        }),
      );

    test("an unavailable diff-stat is short globally, even with no changed-path criterion in the rubric", () => {
      const result = adjudicate({
        ...baseInput({ approvedCriteria: noChangedPathCriterion }),
        proofParse: proofWith([]),
        diffStat: { captured: false, truncated: false, paths: new Set() },
      });
      expect(result.verdict).toBe("short");
      expect(result.reasons[0]).toContain("unavailable or truncated");
    });

    test("a truncated diff-stat is short globally, even with no changed-path criterion in the rubric", () => {
      const result = adjudicate({
        ...baseInput({ approvedCriteria: noChangedPathCriterion }),
        proofParse: proofWith([]),
        diffStat: { captured: true, truncated: true, paths: new Set(["src/x.ts"]) },
      });
      expect(result.verdict).toBe("short");
      expect(result.reasons[0]).toContain("unavailable or truncated");
    });

    test("an overclaimed changed path (not in the sealed diff) is refuted globally — a lie about presence", () => {
      const result = adjudicate({
        ...baseInput({ approvedCriteria: noChangedPathCriterion }),
        proofParse: proofWith(["src/nope.ts"]),
        diffStat: { captured: true, truncated: false, paths: new Set(["src/real.ts"]) },
      });
      expect(result.verdict).toBe("refuted");
      expect(result.reasons[0]).toContain("src/nope.ts");
    });

    test("an underclaimed sealed-diff path (touched but never claimed) is short globally — a gap, not a lie", () => {
      const result = adjudicate({
        ...baseInput({ approvedCriteria: noChangedPathCriterion }),
        proofParse: proofWith(["src/x.ts"]),
        diffStat: { captured: true, truncated: false, paths: new Set(["src/x.ts", "src/hidden.ts"]) },
      });
      expect(result.verdict).toBe("short");
      expect(result.reasons[0]).toContain("src/hidden.ts");
    });

    test("an exact match still reaches the honest floor globally", () => {
      const result = adjudicate({
        ...baseInput({ approvedCriteria: [] }),
        proofParse: proofWith(["src/x.ts"]),
        diffStat: { captured: true, truncated: false, paths: new Set(["src/x.ts"]) },
      });
      expect(result.verdict).toBe("attested");
    });
  });

  test("manual-review evidence always resolves the row, but never lets the BUILD read verified or attested on its own (review finding)", () => {
    const approvedManual: ApprovedCriterion[] = [{ id: "c1", statement: "A human liked the copy.", evidence: ["manual-review"] }];
    const proof = parseProof(
      JSON.stringify({
        version: 1,
        criteria: [{ id: "c1", statement: "A human liked the copy.", verdict: "met", how: "read it", evidence: [{ kind: "manual-review", ref: "read the new copy in src/ui.ts" }] }],
        checks: [], changed: [], caveats: [], screenshots: [],
      }),
    );
    const result = adjudicate({ ...baseInput({ approvedCriteria: approvedManual }), proofParse: proof });
    // A row needing a human's eyes is never machine-verifiable: it stays
    // "short" (needs verification) until an operator explicitly accepts
    // the proof — the SAME accept-anyway act that already lets a
    // short/refuted run read as done, not a new mechanism.
    expect(result.verdict).toBe("short");
    expect(result.matrix[0]?.state).toBe("manual-review");
    expect(result.matrix[0]?.answered).toEqual([{ kind: "manual-review", ref: "read the new copy in src/ui.ts" }]);
    expect(result.reasons[0]).toContain("an operator must accept it");
  });

  test("manual-review still blocks 'verified' even when the approved verify command passes clean (the actual gap the review found)", () => {
    const approvedManual: ApprovedCriterion[] = [{ id: "c1", statement: "A human liked the copy.", evidence: ["manual-review"] }];
    const proof = parseProof(
      JSON.stringify({
        version: 1,
        criteria: [{ id: "c1", statement: "A human liked the copy.", verdict: "met", how: "read it", evidence: [{ kind: "manual-review", ref: "read the new copy" }] }],
        checks: [], changed: [], caveats: [], screenshots: [],
      }),
    );
    const result = adjudicate({
      ...baseInput({ approvedCriteria: approvedManual }),
      proofParse: proof,
      verifyCommand: { configured: true, ran: true, exitCode: 0 },
    });
    expect(result.verdict).toBe("short");
  });

  test("the legacy self-declared verdict can still downgrade an otherwise-resolved criterion, never upgrade one", () => {
    const proof = parseProof(
      JSON.stringify({
        version: 1,
        criteria: [{ id: "c1", statement: APPROVED[0]!.statement, verdict: "not-met", how: "actually it does not work", evidence: [{ kind: "screenshot", ref: "e/a.png" }] }],
        checks: [], changed: [], caveats: [],
        screenshots: [{ path: "e/a.png", caption: "c" }],
      }),
    );
    const result = adjudicate({
      ...baseInput(),
      proofParse: proof,
      screenshots: [{ path: "e/a.png", ok: true, bytes: 4096, dims: { width: 640, height: 480 } }],
    });
    // Evidence resolved (matrix: pass) but the agent's own verdict says
    // not-met — the existing unmet rule still fires and keeps this short.
    expect(result.matrix[0]?.state).toBe("pass");
    expect(result.verdict).toBe("short");
  });

  test("an agent-added criterion beyond the signed rubric is advisory: its own unmet verdict can downgrade, but it is not required", () => {
    const proof = parseProof(
      JSON.stringify({
        version: 1,
        criteria: [
          { id: "c1", statement: APPROVED[0]!.statement, verdict: "met", how: "x", evidence: [{ kind: "screenshot", ref: "e/a.png" }] },
          { id: "extra", statement: "something else I noticed", verdict: "not-checked", how: "ran out of time", evidence: [] },
        ],
        checks: [], changed: [], caveats: [],
        screenshots: [{ path: "e/a.png", caption: "c" }],
      }),
    );
    const result = adjudicate({
      ...baseInput(),
      proofParse: proof,
      screenshots: [{ path: "e/a.png", ok: true, bytes: 4096, dims: { width: 640, height: 480 } }],
    });
    // The extra criterion's own not-checked verdict downgrades the whole
    // build via the pre-existing unmet rule — exactly the "can downgrade,
    // never upgrade" contract for advisory findings.
    expect(result.verdict).toBe("short");
  });
});

// ------------------------------------------------------------- screenshots

describe("screenshot evidence: real PNG/JPEG headers, read without decoding", () => {
  // A tiny valid PNG (1x1) and a synthesized larger one via IHDR bytes.
  const ONE_BY_ONE_PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );

  test("a real 1x1 PNG reports its true, tiny dimensions — not a guess", () => {
    const checked = validateScreenshotBytes(ONE_BY_ONE_PNG);
    expect(checked).toMatchObject({ ok: true, kind: "png" });
    if (!checked.ok) return;
    expect(imageDimensions(ONE_BY_ONE_PNG, checked.kind)).toEqual({ width: 1, height: 1 });
  });

  test("a synthesized 640x480 PNG header reads back exactly", () => {
    const png = Buffer.from(ONE_BY_ONE_PNG);
    png.writeUInt32BE(640, 16);
    png.writeUInt32BE(480, 20);
    expect(imageDimensions(png, "png")).toEqual({ width: 640, height: 480 });
  });

  test("a truncated PNG header returns null, never a fabricated size", () => {
    expect(imageDimensions(ONE_BY_ONE_PNG.subarray(0, 20), "png")).toBeNull();
  });

  test("a minimal JPEG SOF0 segment reports its dimensions", () => {
    // SOI, APP0 skip, SOF0 with precision=8, height=200, width=320.
    const jpeg = Buffer.from([
      0xff, 0xd8, // SOI
      0xff, 0xc0, // SOF0
      0x00, 0x0b, // length = 11
      0x08, // precision
      0x00, 0xc8, // height = 200
      0x01, 0x40, // width = 320
      0x01, 0x01, 0x11, 0x00, // one component
    ]);
    expect(imageDimensions(jpeg, "jpeg")).toEqual({ width: 320, height: 200 });
  });

  test("a JPEG with no SOF before Start Of Scan returns null", () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02]);
    expect(imageDimensions(jpeg, "jpeg")).toBeNull();
  });
});
