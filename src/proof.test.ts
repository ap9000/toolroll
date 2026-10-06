import { describe, test, expect } from "vitest";
import {
  parseProof,
  serializeProof,
  adjudicate,
  verdictWords,
  dispatchStatusToken,
  foldReview,
  semanticCoverage,
  passFraction,
  blockingCaveats,
  caveatAttributionProblems,
  caveatAttributionWords,
  manualReviewCriterionOf,
  manualReviewOnly,
  personCheckWords,
  plainReasonWords,
  failedMetChecks,
  failedCheckWords,
  proofSubmissionProblems,
  PROOF_LIMITS,
  type AdjudicateInput,
  type AdjudicateResult,
  changedListProblems,
  frozenCriterionProblems,
  sameDiffStatFacts,
  type CriterionMatrixRow,
  type CriterionJudgement,
} from "./proof.js";
import { parseNumstat } from "./evidence.js";

const sound = {
  version: 1,
  criteria: [{ id: "c1", statement: "The button opens the settings panel.", verdict: "met", how: "Clicked it in the demo build." }],
  checks: [{ command: "npm test", exitCode: 0, summary: "1668 tests passed." }],
  changed: ["src/x.ts"],
  // A sound proof carries no unattributed caveat (final authority closure):
  // "the panel does not yet remember scroll position" is a follow-up for
  // the handoff, not an exception to a signed criterion.
  caveats: [],
  screenshots: [{ path: "evidence/settings-panel.png", caption: "Settings panel open." }],
};

const parse = (payload: unknown) => parseProof(JSON.stringify(payload));
const problemsOf = (payload: unknown): string[] => {
  const result = parse(payload);
  return result.ok ? [] : result.problems.map(p => p.reason);
};

describe("parseProof", () => {
  test("accepts a sound proof", () => {
    const result = parse(sound);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.proof.criteria).toHaveLength(1);
    expect(result.proof.checks).toHaveLength(1);
    expect(result.proof.changed).toEqual(["src/x.ts"]);
    expect(result.proof.screenshots).toEqual([{ path: "evidence/settings-panel.png", caption: "Settings panel open." }]);
  });

  test("every list is optional except version", () => {
    expect(parse({ version: 1 })).toMatchObject({ ok: true, proof: { criteria: [], checks: [], changed: [], caveats: [], screenshots: [] } });
  });

  test("refuses what is not JSON, and what is JSON but not an object", () => {
    expect(parseProof("not json {")).toMatchObject({ ok: false });
    expect(problemsOf([sound])).toContain("not-an-object");
    expect(parseProof(JSON.stringify("a string"))).toMatchObject({ ok: false });
  });

  test("version is 1 (what a builder writes) or 2 (what is stored); a newer one is refused plainly", () => {
    expect(problemsOf({ ...sound, version: 3 })).toEqual(["newer-version"]);
    expect(problemsOf({ ...sound, version: undefined })).toContain("bad-version");
    expect(problemsOf({ ...sound, version: "1" })).toContain("bad-version");
  });

  test("the whole payload is capped", () => {
    const bloated = { ...sound, caveats: ["x".repeat(PROOF_LIMITS.payload)] };
    expect(parseProof(JSON.stringify(bloated))).toMatchObject({ ok: false });
  });

  describe("criteria", () => {
    test("must be an array", () => {
      expect(problemsOf({ ...sound, criteria: "nope" })).toContain("bad-criteria");
    });
    test("caps at PROOF_LIMITS.criteria", () => {
      const many = Array.from({ length: PROOF_LIMITS.criteria + 1 }, (_, i) => ({ id: `c${i}`, statement: "s", verdict: "met", how: "h" }));
      expect(problemsOf({ ...sound, criteria: many })).toContain("criteria-too-many");
    });
    test("ids must be unique", () => {
      const dupes = [
        { id: "same", statement: "a", verdict: "met", how: "h" },
        { id: "same", statement: "b", verdict: "met", how: "h" },
      ];
      expect(problemsOf({ ...sound, criteria: dupes })).toContain("criteria[1]-duplicate-id");
    });
    test("verdict must be a supported state", () => {
      expect(problemsOf({ ...sound, criteria: [{ id: "c1", statement: "s", verdict: "sort-of", how: "h" }] })).toContain(
        "bad-criteria[0].verdict",
      );
    });
    test("statement and how are required prose, capped and control-free", () => {
      expect(problemsOf({ ...sound, criteria: [{ id: "c1", statement: "", verdict: "met", how: "h" }] })).toContain(
        "missing-criteria[0].statement",
      );
      expect(
        problemsOf({ ...sound, criteria: [{ id: "c1", statement: "x".repeat(PROOF_LIMITS.criterionStatement + 1), verdict: "met", how: "h" }] }),
      ).toContain("criteria[0].statement-too-long");
      expect(
        problemsOf({ ...sound, criteria: [{ id: "c1", statement: "look]0;pwned", verdict: "met", how: "h" }] }),
      ).toContain("criteria[0].statement-controls");
    });
    test("how is capped at PROOF_LIMITS.criterionHow bytes: exact cap accepted, one byte over refused", () => {
      const atCap = "h".repeat(PROOF_LIMITS.criterionHow);
      const atCapResult = parse({ ...sound, criteria: [{ id: "c1", statement: "s", verdict: "met", how: atCap }] });
      expect(atCapResult.ok).toBe(true);
      if (atCapResult.ok) expect(atCapResult.proof.criteria[0].how).toBe(atCap);

      const overCap = "h".repeat(PROOF_LIMITS.criterionHow + 1);
      expect(problemsOf({ ...sound, criteria: [{ id: "c1", statement: "s", verdict: "met", how: overCap }] })).toContain(
        "criteria[0].how-too-long",
      );
    });
  });

  describe("checks", () => {
    test("must be an array capped at PROOF_LIMITS.checks", () => {
      expect(problemsOf({ ...sound, checks: "nope" })).toContain("bad-checks");
      const many = Array.from({ length: PROOF_LIMITS.checks + 1 }, () => ({ command: "npm test", exitCode: 0, summary: "ok" }));
      expect(problemsOf({ ...sound, checks: many })).toContain("checks-too-many");
    });
    test("exitCode must be an integer 0-255", () => {
      expect(problemsOf({ ...sound, checks: [{ command: "c", exitCode: -1, summary: "s" }] })).toContain("bad-checks[0].exitCode");
      expect(problemsOf({ ...sound, checks: [{ command: "c", exitCode: 256, summary: "s" }] })).toContain("bad-checks[0].exitCode");
      expect(problemsOf({ ...sound, checks: [{ command: "c", exitCode: 1.5, summary: "s" }] })).toContain("bad-checks[0].exitCode");
      expect(problemsOf({ ...sound, checks: [{ command: "c", exitCode: "0", summary: "s" }] })).toContain("bad-checks[0].exitCode");
    });
    test("command and summary are required, capped, control-free", () => {
      expect(problemsOf({ ...sound, checks: [{ command: "", exitCode: 0, summary: "s" }] })).toContain("missing-checks[0].command");
    });
  });

  describe("changed and caveats", () => {
    test("changed caps at PROOF_LIMITS.changed entries", () => {
      const many = Array.from({ length: PROOF_LIMITS.changed + 1 }, (_, i) => `src/f${i}.ts`);
      expect(problemsOf({ ...sound, changed: many })).toContain("changed-too-many");
    });
    test("caveats caps at PROOF_LIMITS.caveats entries", () => {
      const many = Array.from({ length: PROOF_LIMITS.caveats + 1 }, (_, i) => `caveat ${i}`);
      expect(problemsOf({ ...sound, caveats: many })).toContain("caveats-too-many");
    });
    test("entries are prose: capped, control-free", () => {
      expect(problemsOf({ ...sound, changed: ["x".repeat(PROOF_LIMITS.changedPath + 1)] })).toContain("changed[0]-too-long");
      expect(problemsOf({ ...sound, caveats: ["look]0;pwned"] })).toContain("caveats[0]-controls");
    });
    test("a caveat is capped at PROOF_LIMITS.caveat bytes UTF-8, not characters: exact cap accepted, one byte over refused", () => {
      // "é" is one character but two UTF-8 bytes — a char-length check would
      // wrongly pass this at half PROOF_LIMITS.caveat characters.
      const atCap = "é".repeat(PROOF_LIMITS.caveat / 2);
      const atCapResult = parse({ ...sound, caveats: [atCap] });
      expect(atCapResult.ok).toBe(true);
      if (atCapResult.ok) expect(atCapResult.proof.caveats[0]).toBe(atCap);

      const overCap = atCap + "x";
      expect(problemsOf({ ...sound, caveats: [overCap] })).toContain("caveats[0]-too-long");
    });
  });

  describe("screenshots", () => {
    test("must be an array capped at PROOF_LIMITS.screenshots", () => {
      expect(problemsOf({ ...sound, screenshots: "nope" })).toContain("bad-screenshots");
      const many = Array.from({ length: PROOF_LIMITS.screenshots + 1 }, (_, i) => ({ path: `e/${i}.png`, caption: "c" }));
      expect(problemsOf({ ...sound, screenshots: many })).toContain("screenshots-too-many");
    });
    test("path must be a normalized repository-relative path", () => {
      expect(problemsOf({ ...sound, screenshots: [{ path: "/etc/passwd", caption: "c" }] })).toContain(
        "screenshots[0].path-not-relative",
      );
      expect(problemsOf({ ...sound, screenshots: [{ path: "../../etc/passwd", caption: "c" }] })).toContain(
        "screenshots[0].path-not-relative",
      );
      expect(problemsOf({ ...sound, screenshots: [{ path: "a\\b.png", caption: "c" }] })).toContain(
        "screenshots[0].path-not-relative",
      );
    });
    test("paths must be unique", () => {
      const dupes = [
        { path: "e/a.png", caption: "a" },
        { path: "e/a.png", caption: "b" },
      ];
      expect(problemsOf({ ...sound, screenshots: dupes })).toContain("screenshots[1]-duplicate-path");
    });
    test("caption is required prose", () => {
      expect(problemsOf({ ...sound, screenshots: [{ path: "e/a.png", caption: "" }] })).toContain(
        "missing-screenshots[0].caption",
      );
    });
  });

  test("re-serializes to the validated shape, not the raw bytes", () => {
    const result = parse({ ...sound, extraField: "ignored", criteria: [{ id: "c1", statement: "s", verdict: "met", how: "h", extra: "x" }] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const serialized = serializeProof(result.proof);
    expect(serialized).not.toContain("extraField");
    expect(serialized).not.toContain("\"extra\"");
    expect(JSON.parse(serialized)).toEqual(result.proof);
  });
});

describe("machine-owned final check", () => {
  const statement = "Focused safeguards pass and the approved final check succeeds";
  const payload = (verdict = "pending-verification") => ({
    version: 1, criteria: [{ id: "c6", statement, verdict, how: "Focused checks passed; only the machine check remains.", evidence: [{ kind: "check", ref: "focused" }] }],
    checks: [{ command: "focused", exitCode: 0, summary: "passed" }], changed: ["src/x.ts"], screenshots: [], caveats: [],
  });
  const facts = (verdict = "pending-verification"): AdjudicateInput => ({
    proofArtifactPresent: true, proofParse: parse(payload(verdict)), handoffPresent: true,
    terminalDiffPresent: true, terminalDiffCaptureStatus: "ok",
    diffStat: { captured: true, truncated: false, paths: new Set(["src/x.ts"]) }, screenshots: [],
    approvedCriteria: [{ id: "c6", statement, evidence: ["check"] }],
    verifyCommand: { configured: true, ran: true, exitCode: 0 },
  });

  test("resolves an explicit pending answer only after the final check, without rewriting the receipt", () => {
    const input = facts();
    const before = JSON.stringify(input.proofParse);
    expect(adjudicate(input)).toMatchObject({ verdict: "verified", matrix: [{ id: "c6", state: "pass" }] });
    expect(JSON.stringify(input.proofParse)).toBe(before);
    const parsed = input.proofParse!;
    if (!parsed.ok) throw Error("invalid fixture");
    expect(proofSubmissionProblems(parsed.proof, input.approvedCriteria!)).toEqual([]);
    expect(parseProof(serializeProof(parsed.proof))).toEqual(parsed);
  });

  test.each([
    { configured: false } as const,
    { configured: true, ran: false } as const,
    { configured: true, ran: false, failure: "custody-lost" } as const,
  ])("missing final check remains pending: %j", verifyCommand => {
    expect(adjudicate({ ...facts(), verifyCommand })).toMatchObject({ verdict: "short", matrix: [{ state: "missing" }] });
  });

  test("failed final check is refuted, never promoted", () => {
    expect(adjudicate({ ...facts(), verifyCommand: { configured: true, ran: true, exitCode: 1 } }).verdict).toBe("refuted");
  });

  test.each(["not-met", "not-checked"])("legacy %s is never guessed to mean pending", verdict => {
    expect(adjudicate(facts(verdict)).verdict).toBe("short");
  });

  test("unsigned, extra, or non-check requirements cannot delegate completion", () => {
    for (const approvedCriteria of [[], [{ id: "other", statement, evidence: ["check"] as const }], [{ id: "c6", statement, evidence: [] }]]) {
      const input = { ...facts(), approvedCriteria };
      expect(adjudicate(input).verdict).not.toBe("verified");
      if (input.proofParse?.ok) expect(proofSubmissionProblems(input.proofParse.proof, approvedCriteria).join(" ")).toContain("signed requirements");
    }
  });

  test("failed focused checks, caveats and missing evidence still block", () => {
    const p = payload();
    for (const invalid of [
      { ...p, checks: [{ command: "focused", exitCode: 1, summary: "failed" }] },
      { ...p, caveats: ["c6: approval behavior is still broken"] },
      { ...p, checks: [] },
      { ...p, criteria: [{ ...p.criteria[0], evidence: [...p.criteria[0]!.evidence, { kind: "check", ref: "second" }] }], checks: [...p.checks, { command: "second", exitCode: 1, summary: "failed" }] },
      { ...p, criteria: [{ ...p.criteria[0], statement: "different terms" }] },
    ]) expect(adjudicate({ ...facts(), proofParse: parse(invalid) }).verdict).not.toBe("verified");
    const failed = parse({ ...p, checks: [{ command: "focused", exitCode: 1, summary: "failed" }] });
    if (!failed.ok) throw Error("invalid fixture");
    expect(failedMetChecks(failed.proof)).toHaveLength(1);
    expect(blockingCaveats({ ...failed.proof, caveats: ["c6: unfinished"] })).toHaveLength(1);
  });

  test("machine success cannot replace screenshots, manual review or a valid sealed diff", () => {
    const p = payload();
    const manual = { ...p, criteria: [{ ...p.criteria[0], evidence: [...p.criteria[0]!.evidence, { kind: "manual-review", ref: "eyes required" }] }] };
    expect(adjudicate({ ...facts(), proofParse: parse(manual), approvedCriteria: [{ id: "c6", statement, evidence: ["check", "manual-review"] }] }).verdict).toBe("short");
    expect(adjudicate({ ...facts(), approvedCriteria: [{ id: "c6", statement, evidence: ["check", "screenshot"] }] }).verdict).not.toBe("verified");
    expect(adjudicate({ ...facts(), terminalDiffPresent: false }).verdict).toBe("short");
    expect(adjudicate({ ...facts(), diffStat: { captured: true, truncated: false, paths: new Set(["elsewhere.ts"]) } }).verdict).toBe("refuted");
  });
});

describe("adjudicate", () => {
  const base: AdjudicateInput = {
    proofArtifactPresent: true,
    proofParse: parse(sound),
    handoffPresent: true,
    terminalDiffPresent: true,
    terminalDiffCaptureStatus: "ok",
    diffStat: { captured: true, truncated: false, paths: new Set(["src/x.ts"]) },
    verifyCommand: { configured: false },
    screenshots: [{ path: "evidence/settings-panel.png", ok: true }],
  };

  test("rule 1: no proof artifact at all -> short", () => {
    expect(adjudicate({ ...base, proofArtifactPresent: false, proofParse: null })).toMatchObject({
      verdict: "short",
      reasons: ["no proof was written"],
    });
  });

  test("rule 2: malformed proof -> short, names the problem", () => {
    const malformed = parseProof("not json {");
    const result = adjudicate({ ...base, proofParse: malformed });
    expect(result.verdict).toBe("short");
    expect(result.reasons[0]).toMatch(/malformed/);
  });

  test("rule 3: missing handoff -> short", () => {
    expect(adjudicate({ ...base, handoffPresent: false })).toMatchObject({ verdict: "short" });
  });

  test("rule 3: missing terminal diff -> short", () => {
    expect(adjudicate({ ...base, terminalDiffPresent: false })).toMatchObject({ verdict: "short" });
  });

  test("rule 3: failed diff capture -> short", () => {
    expect(adjudicate({ ...base, terminalDiffCaptureStatus: "failed" })).toMatchObject({ verdict: "short" });
  });

  test("rule 4: a claimed changed path absent from the sealed, untruncated stat -> refuted", () => {
    const result = adjudicate({ ...base, diffStat: { captured: true, truncated: false, paths: new Set(["src/other.ts"]) } });
    expect(result.verdict).toBe("refuted");
    expect(result.reasons[0]).toContain("src/x.ts");
  });

  test("rule 4 does not fire when the stat is truncated — cannot prove absence", () => {
    const result = adjudicate({ ...base, diffStat: { captured: true, truncated: true, paths: new Set() } });
    expect(result.verdict).not.toBe("refuted");
  });

  test("rule 4 does not fire when the stat failed to capture", () => {
    const result = adjudicate({ ...base, diffStat: { captured: false, truncated: false, paths: new Set() } });
    expect(result.verdict).not.toBe("refuted");
  });

  describe("rule 4 on a detected rename: the sealed diff names the destination only (comment 396, run 1642)", () => {
    // Run 1642 moved scripts/claude-review-schema-smoke.mjs to src/fixtures/
    // and its proof listed both names. The sealed stat comes from `git diff
    // --numstat -z` with rename detection: one entry, old and new path as
    // the following tokens, and settlement reads only `path` — exactly as
    // the builder restates the stat for adjudication.
    const NUL = "\u0000";
    const stat = parseNumstat(`1${"\t"}0${"\t"}src/x.ts${NUL}5${"\t"}2${"\t"}${NUL}scripts/smoke.mjs${NUL}src/fixtures/smoke.mjs${NUL}`, "base", "head");
    const sealed = { captured: true, truncated: false, paths: new Set(stat.files.map(one => one.path)) };
    const criterion = { id: "c1", statement: "The button opens the settings panel.", evidence: ["changed-path"] as ("changed-path")[] };
    const claiming = (changed: string[]) =>
      parse({
        ...sound,
        criteria: [{ ...sound.criteria[0], evidence: [{ kind: "changed-path", ref: "src/fixtures/smoke.mjs" }] }],
        changed,
      });

    test("the stat itself keeps the old name as provenance, never as a second path", () => {
      expect(stat.files).toEqual([
        { path: "src/x.ts", additions: 1, deletions: 0 },
        { path: "src/fixtures/smoke.mjs", additions: 5, deletions: 2, renamedFrom: "scripts/smoke.mjs" },
      ]);
      expect([...sealed.paths]).toEqual(["src/x.ts", "src/fixtures/smoke.mjs"]);
    });

    test("listing both names overclaims the old one: refuted, and the reason names it", () => {
      const result = adjudicate({ ...base, diffStat: sealed, proofParse: claiming(["src/x.ts", "scripts/smoke.mjs", "src/fixtures/smoke.mjs"]), approvedCriteria: [criterion] });
      expect(result.verdict).toBe("refuted");
      expect(result.reasons).toEqual(["claimed changed path not in the sealed diff: scripts/smoke.mjs"]);
    });

    test("listing only the old name is an overclaim AND an omission — the overclaim rules first", () => {
      const result = adjudicate({ ...base, diffStat: sealed, proofParse: claiming(["src/x.ts", "scripts/smoke.mjs"]), approvedCriteria: [criterion] });
      expect(result.verdict).toBe("refuted");
      expect(result.reasons).toEqual(["claimed changed path not in the sealed diff: scripts/smoke.mjs"]);
    });

    test("the destination alone equals the sealed diff: the changed-path row passes", () => {
      const result = adjudicate({ ...base, diffStat: sealed, proofParse: claiming(["src/x.ts", "src/fixtures/smoke.mjs"]), approvedCriteria: [criterion] });
      expect(result.verdict).toBe("attested");
      expect(result.matrix).toMatchObject([{ id: "c1", state: "pass", detail: [] }]);
    });

    describe("changedListProblems: the pre-review correction boundary's review of the list against the sealed stat", () => {
      // The builder reads this BEFORE the first review and, when every
      // discrepancy is one the sealed stat explains, hands the exact sealed
      // inventory back to the same session as a receipt-only correction.
      // Adjudication above is unchanged: it still judges whatever list the
      // receipt finally carries.
      const withRenames = { ...sealed, renames: new Map([["scripts/smoke.mjs", "src/fixtures/smoke.mjs"]]) };

      test("the old name of a paired rename is explained: recoverable, and the one admissible answer is the sealed list", () => {
        expect(changedListProblems(["src/x.ts", "scripts/smoke.mjs", "src/fixtures/smoke.mjs"], withRenames)).toEqual({
          problems: ['changed lists "scripts/smoke.mjs", the old name of a move the sealed diff records once as "src/fixtures/smoke.mjs" — list the destination only'],
          recoverable: true,
          sealed: ["src/fixtures/smoke.mjs", "src/x.ts"],
        });
      });

      test("a sealed path the list left out is explained too", () => {
        expect(changedListProblems(["src/fixtures/smoke.mjs"], withRenames)).toEqual({
          problems: ['changed omits "src/x.ts", which the sealed diff contains'],
          recoverable: true,
          sealed: ["src/fixtures/smoke.mjs", "src/x.ts"],
        });
      });

      test("a path the sealed diff never had is an unexplained contradiction: reported, never recoverable", () => {
        const review = changedListProblems(["src/x.ts", "src/fixtures/smoke.mjs", "src/other.ts"], withRenames);
        expect(review).toMatchObject({ recoverable: false, problems: ['changed lists "src/other.ts", which the sealed diff does not contain'] });
        // Beside a rename's old name it still poisons the whole review.
        expect(changedListProblems(["scripts/smoke.mjs", "src/fixtures/smoke.mjs", "src/x.ts", "src/other.ts"], withRenames).recoverable).toBe(false);
      });

      test("without rename provenance the old name is just a path the diff never had", () => {
        expect(changedListProblems(["src/x.ts", "scripts/smoke.mjs", "src/fixtures/smoke.mjs"], sealed)).toMatchObject({ recoverable: false });
      });

      test("an exact list has nothing to correct", () => {
        expect(changedListProblems(["src/fixtures/smoke.mjs", "src/x.ts"], withRenames)).toEqual({ problems: [], recoverable: false, sealed: ["src/fixtures/smoke.mjs", "src/x.ts"] });
      });

      test.each([
        ["missing", null],
        ["uncaptured", { captured: false, truncated: false, paths: new Set<string>() }],
        ["truncated", { captured: true, truncated: true, paths: new Set(["src/x.ts"]) }],
      ])("a %s stat proves nothing either way: no problems, no correction", (_label, stat) => {
        expect(changedListProblems(["src/x.ts", "scripts/smoke.mjs"], stat)).toEqual({ problems: [], recoverable: false, sealed: null });
      });
    });

    describe("frozenCriterionProblems: a receipt-only correction freezes every submitted id/verdict pair (comment 397, run 1648)", () => {
      const answer = (id: string, verdict: string, statement = `criterion ${id}`) => ({ id, statement, verdict, how: "checked", evidence: [] });
      const proofOf = (criteria: ReturnType<typeof answer>[]) => {
        const parsed = parseProof(JSON.stringify({ ...sound, criteria }));
        if (!parsed.ok) throw new Error(parsed.problems.map(one => one.message).join("; "));
        return parsed.proof;
      };
      const submitted = proofOf([answer("c1", "not-met", "the guard exists (requires evidence: check)"), answer("c2", "not-checked"), answer("x1", "not-met")]);

      test("a statement or reference correction that keeps every pair is clean", () => {
        expect(frozenCriterionProblems(submitted, proofOf([answer("c1", "not-met", "the guard exists"), answer("c2", "not-checked"), answer("x1", "not-met")]))).toEqual([]);
        // Order is not a pair: the same answers, reordered, still hold.
        expect(frozenCriterionProblems(submitted, proofOf([answer("x1", "not-met"), answer("c2", "not-checked"), answer("c1", "not-met")]))).toEqual([]);
      });

      test.each([
        ["not-met", "pending-verification"],
        ["not-checked", "pending-verification"],
        ["not-met", "met"],
        ["not-checked", "met"],
        ["met", "not-met"],
      ])("an answer submitted as %s cannot become %s", (before, after) => {
        const one = proofOf([answer("c1", before)]);
        expect(frozenCriterionProblems(one, proofOf([answer("c1", after)]))).toEqual([
          `criterion c1 was submitted as ${before}; a receipt-only correction cannot change it to ${after}`,
        ]);
      });

      test("a dropped extra negative criterion, a dropped signed one and an added one are each named", () => {
        expect(frozenCriterionProblems(submitted, proofOf([answer("c1", "not-met"), answer("c2", "not-checked")]))).toEqual([
          "criterion x1 (not-met) was dropped; every submitted criterion and its verdict are frozen by a receipt-only correction",
        ]);
        expect(frozenCriterionProblems(submitted, proofOf([answer("c2", "not-checked"), answer("x1", "not-met"), answer("x2", "met")]))).toEqual([
          "criterion c1 (not-met) was dropped; every submitted criterion and its verdict are frozen by a receipt-only correction",
          "criterion x2 was added; a receipt-only correction answers exactly the submitted criteria",
        ]);
      });
    });

    describe("sameDiffStatFacts: the settlement re-reads the sealed stat after the correction and after the gate", () => {
      const facts = { captured: true, truncated: false, paths: new Set(["src/x.ts", "src/fixtures/smoke.mjs"]), renames: new Map([["scripts/smoke.mjs", "src/fixtures/smoke.mjs"]]) };

      test("the same facts in any order agree; a missing or uncaptured pair agrees only with itself", () => {
        expect(sameDiffStatFacts(facts, { ...facts, paths: new Set(["src/fixtures/smoke.mjs", "src/x.ts"]) })).toBe(true);
        expect(sameDiffStatFacts(null, null)).toBe(true);
        expect(sameDiffStatFacts({ captured: false, truncated: false, paths: new Set() }, { captured: false, truncated: false, paths: new Set() })).toBe(true);
        expect(sameDiffStatFacts(facts, null)).toBe(false);
        expect(sameDiffStatFacts(null, facts)).toBe(false);
      });

      test.each([
        ["lost capture", { captured: false, truncated: false, paths: new Set<string>() }],
        ["truncated", { ...facts, truncated: true }],
        ["a path gone", { ...facts, paths: new Set(["src/x.ts"]) }],
        ["a path added", { ...facts, paths: new Set([...facts.paths, "src/other.ts"]) }],
        ["rename provenance gone", { captured: true, truncated: false, paths: facts.paths }],
      ])("a re-read that %s is a different reading", (_label, reread) => {
        expect(sameDiffStatFacts(facts, reread)).toBe(false);
      });
    });
  });

  test("altering a signed criterion remains refuted when verification could not run", () => {
    const signed = "The button opens the settings panel.";
    const restated = "The button closes the settings panel.";
    const altered = parse({
      ...sound,
      criteria: [{ id: "c1", statement: restated, verdict: "met", how: "Clicked it in the demo build." }],
    });
    const result = adjudicate({
      ...base,
      proofParse: altered,
      approvedCriteria: [{ id: "c1", statement: signed, evidence: [] }],
      verifyCommand: { configured: true, ran: false, attemptFailed: true, failure: "spawn-failed" },
    });
    expect(result).toMatchObject({
      verdict: "refuted",
      reasons: [`criterion "c1" was signed as "${signed}" and the proof restates it as "${restated}"`],
    });
  });

  test("rule 5: an approved verification command that exits non-zero -> refuted", () => {
    const result = adjudicate({ ...base, verifyCommand: { configured: true, ran: true, exitCode: 1 } });
    expect(result).toMatchObject({
      verdict: "refuted",
      reasons: ["the repository's approved verification command exited 1"],
    });
  });

  test("a check passing after bounded setup replay is verified", () => {
    const result = adjudicate({ ...base, verifyCommand: { configured: true, ran: true, exitCode: 0, setupReplayed: true } });
    expect(result).toMatchObject({
      verdict: "verified",
      reasons: ["the approved verification command passed after the approved setup command ran"],
    });
  });

  test("a check that starts but fails after setup replay is refuted", () => {
    const result = adjudicate({ ...base, verifyCommand: { configured: true, ran: true, exitCode: 1, setupReplayed: true } });
    expect(result).toMatchObject({
      verdict: "refuted",
      reasons: ["the repository's approved verification command exited 1 after the approved setup command was replayed"],
    });
  });

  test.each([
    ["spawn-failed", "the approved verification command could not be run"],
    ["dependency-missing", "the approved verification command could not start because a required project executable was unavailable and no approved recovery was enabled"],
    ["setup-stale", "automatic recovery stopped because the project setup or check changed"],
    ["setup-failed", "the approved setup command failed during automatic recovery"],
    ["tracked-files-changed", "automatic recovery stopped because tracked files no longer matched the built result"],
    ["dependency-still-missing", "the required project executable was still unavailable after replaying the approved setup command"],
    ["setup-changed-files", "automatic recovery stopped because the setup command changed tracked files after the build"],
    ["checkout-moved", "automatic recovery stopped because the checkout moved away from the built commit"],
    ["cleanliness-unavailable", "automatic recovery stopped because Toolroll could not confirm that the built checkout was unchanged"],
    ["custody-lost", "automatic recovery stopped because this worker no longer owned the build"],
  ] as const)("automatic recovery failure %s stays short", (failure, reason) => {
    const result = adjudicate({
      ...base,
      verifyCommand: { configured: true, ran: false, attemptFailed: true, failure },
    });
    expect(result).toMatchObject({ verdict: "short", reasons: [reason] });
  });

  test("rule 6: any criterion not-met or not-checked -> short", () => {
    const notMet = parse({ ...sound, criteria: [{ id: "c1", statement: "s", verdict: "not-met", how: "h" }] });
    expect(adjudicate({ ...base, proofParse: notMet })).toMatchObject({ verdict: "short" });
    const notChecked = parse({ ...sound, criteria: [{ id: "c1", statement: "s", verdict: "not-checked", how: "h" }] });
    expect(adjudicate({ ...base, proofParse: notChecked })).toMatchObject({ verdict: "short" });
  });

  test("an unverifiable claimed screenshot -> short", () => {
    const result = adjudicate({ ...base, screenshots: [{ path: "evidence/settings-panel.png", ok: false, problem: "not a PNG or JPEG" }] });
    expect(result.verdict).toBe("short");
    expect(result.reasons[0]).toContain("evidence/settings-panel.png");
  });

  test("rule 7: an approved verification command that passes -> verified", () => {
    const result = adjudicate({ ...base, verifyCommand: { configured: true, ran: true, exitCode: 0 } });
    expect(result.verdict).toBe("verified");
  });

  test("rule 7: no verification command configured -> attested, the honest floor", () => {
    expect(adjudicate(base)).toMatchObject({ verdict: "attested" });
  });

  test("a configured command that could not be run at all -> short, not refuted", () => {
    const result = adjudicate({ ...base, verifyCommand: { configured: true, ran: false, attemptFailed: true } });
    expect(result.verdict).toBe("short");
  });

  // The run 1497 contradictions, pinned (atomic authority closure): that
  // proof marked c1 and c4 met while its own caveats admitted the
  // no-scope unstamped row and the routine edge page. A caveat that names
  // a met criterion's id is a blocking exception — the proof disagrees
  // with itself and is refuted, whether or not a rubric was signed, and
  // even when the approved verification command could not run.
  const run1497 = {
    c1: "Reviewer, contest, attended, base, resume, repair, and no-scope run admission proves its live request, lane or authorization and exact route or custody in the same transaction as insertion, and no generic or post-insert path can bypass it or leave a row.",
    c4: "Routine integrity validates exact raw stored terms and build or repair parity before consent or approval and before firing, and any corruption leaves the routine, slot, ledger, task, notification, and next-fire rows unchanged.",
  };
  const noScopeCaveat = "c1: A task with no scope still opens an unstamped run when nothing is presented (kept to avoid churn across ~250 fixtures); the spend gate refuses such rows.";
  const routinePageCaveat = "c4: A corrupt routine SNAPSHOT still pages once at the edge (pre-existing pinned behavior); corrupt raw TERMS write nothing at all, not even a page.";
  const contradicted = (verdict: "met" | "not-met") =>
    parse({
      ...sound,
      criteria: [
        { id: "c1", statement: run1497.c1, verdict, how: "startRun proves in its insert." },
        { id: "c4", statement: run1497.c4, verdict, how: "readRoutine sets termsProblem." },
      ],
      caveats: [noScopeCaveat, routinePageCaveat],
    });
  // The EXACT caveats runs 1497 and 1500 stored (final authority closure):
  // not one names a criterion id, so the machine cannot say which signed
  // criterion each qualifies — every one is unassigned, and a proof that
  // carries them is refuted, never verified, however its criteria read.
  const run1497Caveats = [
    "A task with no scope still opens an unstamped run when nothing is presented (kept to avoid churn across ~250 fixtures); the spend gate refuses such rows. A presented no-scope stamp must be the bare word legacy.",
    "Pre-routing (route_era NULL) chain approvals can no longer run non-primary fallback entries; the tick reports fallback-stale-approval with the reason until the scope is re-filed and approved.",
    "A corrupt routine SNAPSHOT still pages once at the edge (pre-existing pinned behavior); corrupt raw TERMS write nothing at all, not even a page.",
    "Reviewer proofs use an injected stubbed reviewer agent, not a live provider; migration proofs replay a logical SQL dump of a v47 database, not a binary v47 file.",
  ];
  const run1500Caveats = [
    "Attended launch refusals after admission (stale head, run-held, session-cap) now close the admission-bound authorization as refused:<reason>; the operator re-authorizes instead of an automatic retry.",
    "The blocking-caveat rule is a token contract: a caveat that admits an exception without naming the criterion id is not machine-attributable; the brief tells agents to name it.",
    "Contest lane repair turns on routed tasks were refused before this change too (sealed-route leg vs lane profile); untouched and not covered by tests.",
    "Auth-mode strictness at filing, consent, and seal reads the operator's home through readAuthModeStrict with no keyHome injection; tests point HOME at a temp dir.",
    "Migrated routines with an empty legacy rubric stay refreshable and approvable (storedRubric); the filing door still requires at least one criterion.",
  ];
  const stored = (caveats: string[], verdict: "met" | "not-met" = "met") =>
    parse({
      ...sound,
      criteria: [
        { id: "c1", statement: run1497.c1, verdict, how: "startRun proves in its insert." },
        { id: "c4", statement: run1497.c4, verdict, how: "readRoutine sets termsProblem." },
      ],
      caveats,
    });

  test("run 1497 pinned: a met c1 whose caveat admits the no-scope row, and a met c4 whose caveat admits the routine page, refute the proof", () => {
    const result = adjudicate({ ...base, proofParse: contradicted("met"), diffStat: { captured: true, truncated: false, paths: new Set(["src/x.ts"]) } });
    expect(result.verdict).toBe("refuted");
    expect(result.reasons).toEqual([
      `criterion "c1" is marked met, but caveat 1 admits an exception to it: ${noScopeCaveat}`,
      `criterion "c4" is marked met, but caveat 2 admits an exception to it: ${routinePageCaveat}`,
    ]);
    expect(verdictWords(result.verdict, result.reasons).word).toBe("conflicting evidence");
  });

  test("run 1497 pinned: the same caveats against not-met criteria are honest — short, never refuted", () => {
    const result = adjudicate({ ...base, proofParse: contradicted("not-met") });
    expect(result.verdict).toBe("short");
    expect(result.reasons.every(one => /is not met/.test(one))).toBe(true);
  });

  test("a blocking caveat outranks an unavailable verification command and fails the signed row in the matrix", () => {
    const result = adjudicate({
      ...base,
      proofParse: contradicted("met"),
      approvedCriteria: [
        { id: "c1", statement: run1497.c1, evidence: [] },
        { id: "c4", statement: run1497.c4, evidence: [] },
      ],
      verifyCommand: { configured: true, ran: false, attemptFailed: true, failure: "spawn-failed" },
    });
    expect(result.verdict).toBe("refuted");
    expect(result.matrix.map(row => [row.id, row.state])).toEqual([
      ["c1", "failed"],
      ["c4", "failed"],
    ]);
    expect(result.matrix[0]!.detail[0]).toBe(`criterion "c1" is marked met, but caveat 1 admits an exception to it: ${noScopeCaveat}`);
  });

  for (const [label, caveats] of [
    ["run 1497", run1497Caveats],
    ["run 1500", run1500Caveats],
  ] as const) {
    test(`${label}'s exact stored caveats name no criterion: every one is unassigned, and the proof is refuted whether its criteria read met or not-met`, () => {
      const problems = caveatAttributionProblems({ criteria: [], caveats: [...caveats] }, ["c1", "c2", "c3", "c4", "c5", "c6"]);
      expect(problems.map(one => [one.index, one.kind])).toEqual(caveats.map((_, index) => [index, "unassigned"]));
      for (const verdict of ["met", "not-met"] as const) {
        const result = adjudicate({ ...base, proofParse: stored([...caveats], verdict), diffStat: { captured: true, truncated: false, paths: new Set(["src/x.ts"]) } });
        expect(result.verdict).toBe("refuted");
        expect(result.reasons).toEqual(caveats.map((caveat, index) => `caveat ${index + 1} names no criterion — every caveat is an exception to exactly one signed criterion, named by its exact id (an unrelated idea belongs in the handoff's follow-ups): ${caveat}`));
        expect(verdictWords(result.verdict, result.reasons).word).toBe("conflicting evidence");
      }
    });
  }

  test("a caveat tagged with an id nobody signed and the proof never answers is unknown — refuted in words; a signed id the proof does not answer is still known", () => {
    const unknown = "c9: the routine page still renders the old words.";
    const result = adjudicate({ ...base, proofParse: stored([unknown], "not-met") });
    expect(result.verdict).toBe("refuted");
    expect(result.reasons).toEqual([`caveat 1 names "c9", which is no signed or answered criterion — every caveat names an exact criterion id: ${unknown}`]);
    expect(caveatAttributionProblems({ criteria: [], caveats: [unknown] }, ["c9"])).toEqual([]);
    expect(caveatAttributionProblems({ criteria: [], caveats: ["c1, c9: both"] }, ["c1"])).toEqual([{ caveat: "c1, c9: both", index: 0, kind: "unknown", tags: ["c9"] }]);
    expect(caveatAttributionWords({ caveat: "x", index: 2, kind: "unassigned", tags: [] })).toContain("caveat 3 names no criterion");
  });

  test("a proof-authored extra id is no signed authority (final admission closure): with a signed rubric, a caveat tagged with it alone is unknown in adjudication — and an untagged caveat naming only it is unassigned; with nothing signed, the proof's answered criteria attribute", () => {
    const extra = "c7: The routine page still renders the old words under the extra criterion this proof wrote for itself.";
    const withExtra = (caveats: string[], extraVerdict: "met" | "not-met" = "not-met") =>
      parse({
        ...sound,
        criteria: [
          { id: "c1", statement: run1497.c1, verdict: "not-met", how: "startRun proves in its insert." },
          { id: "c4", statement: run1497.c4, verdict: "not-met", how: "readRoutine sets termsProblem." },
          { id: "c7", statement: "An extra criterion the proof recorded on its own.", verdict: extraVerdict, how: "noted" },
        ],
        caveats,
      });
    const signed = [
      { id: "c1", statement: run1497.c1, evidence: [] },
      { id: "c4", statement: run1497.c4, evidence: [] },
    ];
    // Adjudication under the signed rubric: the proof answers c7, but c7
    // was never signed — the tag is unknown, the proof refuted.
    const refuted = adjudicate({ ...base, proofParse: withExtra([extra]), approvedCriteria: signed });
    expect(refuted.verdict).toBe("refuted");
    // The words say the id is the proof's own, never that nobody answered it.
    expect(refuted.reasons).toEqual([`caveat 1 names "c7", a criterion the proof authored for itself that nobody signed — a proof-only id is no signed authority; every caveat names a signed criterion's exact id: ${extra}`]);
    // The pure function agrees, whether c7 is the only tag or rides with a signed one.
    const answersExtra = { criteria: [{ id: "c7", statement: "s", verdict: "not-met" as const, how: "h", evidence: [] }], caveats: [extra] };
    expect(caveatAttributionProblems(answersExtra, ["c1", "c4"])).toEqual([{ caveat: extra, index: 0, kind: "unknown", tags: ["c7"], answered: ["c7"] }]);
    expect(caveatAttributionProblems({ ...answersExtra, caveats: ["c1, c7: both"] }, ["c1", "c4"])).toEqual([{ caveat: "c1, c7: both", index: 0, kind: "unknown", tags: ["c7"], answered: ["c7"] }]);
    // A tag the proof never answered keeps the plain words, beside an answered one.
    expect(caveatAttributionWords({ caveat: "c7, c9: both", index: 0, kind: "unknown", tags: ["c7", "c9"], answered: ["c7"] })).toContain('names "c7", "c9", which is no signed or answered criterion');
    // An untagged caveat whose only standalone id is the proof-authored
    // one names nothing signed: unassigned, not attributed.
    const untagged = "The extra criterion c7 still renders the old words.";
    expect(caveatAttributionProblems({ ...answersExtra, caveats: [untagged] }, ["c1", "c4"])).toEqual([{ caveat: untagged, index: 0, kind: "unassigned", tags: [] }]);
    expect(adjudicate({ ...base, proofParse: withExtra([untagged]), approvedCriteria: signed }).reasons).toEqual([`caveat 1 names no criterion — every caveat is an exception to exactly one signed criterion, named by its exact id (an unrelated idea belongs in the handoff's follow-ups): ${untagged}`]);
    // A signed id the proof answers attributes as before, beside the extra criterion.
    const ok = adjudicate({ ...base, proofParse: withExtra(["c1: the no-scope row is kept for now."]), approvedCriteria: signed });
    expect(ok.verdict).toBe("short");
    expect(ok.reasons.some(one => /caveat/.test(one))).toBe(false);
    // UNSIGNED context: no rubric — the proof's own answered criteria are
    // the known ids, so the same c7 tag attributes.
    expect(caveatAttributionProblems(answersExtra, [])).toEqual([]);
    const unsigned = adjudicate({ ...base, proofParse: withExtra([extra]) });
    expect(unsigned.reasons.some(one => /names "c7"/.test(one))).toBe(false);
    expect(unsigned.verdict).not.toBe("refuted");
  });

  test("attributed caveats against not-met criteria pass attribution: a mixed proof is refuted only for the caveat that names nothing", () => {
    const mixed = [noScopeCaveat, routinePageCaveat, run1497Caveats[3]!];
    const result = adjudicate({ ...base, proofParse: stored(mixed, "not-met") });
    expect(result.verdict).toBe("refuted");
    expect(result.reasons).toHaveLength(1);
    expect(result.reasons[0]).toContain("caveat 3 names no criterion");
  });

  test("blockingCaveats names a criterion only by its exact standalone id token", () => {
    const criteria = [
      { id: "c1", statement: "s", verdict: "met" as const, how: "h", evidence: [] },
      { id: "c10", statement: "s", verdict: "met" as const, how: "h", evidence: [] },
      { id: "c2", statement: "s", verdict: "not-met" as const, how: "h", evidence: [] },
    ];
    const named = (caveats: string[]) => blockingCaveats({ criteria, caveats }).map(one => `${one.index}:${one.criterionId}`);
    expect(named(["c10 still pages once"])).toEqual(["0:c10"]);
    expect(named(["(c1) kept for churn", "c1,c10 both"])).toEqual(["0:c1", "1:c1", "1:c10"]);
    expect(named(["c2: honestly not met"])).toEqual([]);
    expect(named(["ac1 and c1x and c1-ish and c1_ are other words", "The panel does not remember scroll position."])).toEqual([]);
  });

  test("failedMetChecks names every check a MET criterion cites that exited nonzero, in the adjudicator's own words; not-met and not-checked criteria report failed checks honestly (proof preflight closure)", () => {
    const checks = [
      { command: "npx vitest run src/a.test.ts", exitCode: 0, summary: "green" },
      { command: "npx tsx scripts/counterexample.ts", exitCode: 1, summary: "the counterexample reproduces" },
      { command: "npm run typecheck", exitCode: 2, summary: "one error" },
    ];
    const cite = (...refs: string[]) => refs.map(ref => ({ kind: "check" as const, ref }));
    const criteria = [
      { id: "c1", statement: "s", verdict: "met" as const, how: "h", evidence: cite("npx vitest run src/a.test.ts") },
      { id: "c2", statement: "s", verdict: "met" as const, how: "h", evidence: cite("npx tsx scripts/counterexample.ts", "npm run typecheck") },
      { id: "c3", statement: "s", verdict: "not-met" as const, how: "h", evidence: cite("npx tsx scripts/counterexample.ts") },
      { id: "c4", statement: "s", verdict: "not-checked" as const, how: "h", evidence: cite("npm run typecheck") },
      // A ref that resolves to no check is an unresolved ref, not a failed one.
      { id: "c5", statement: "s", verdict: "met" as const, how: "h", evidence: cite("npm run build") },
    ];
    const found = failedMetChecks({ criteria, checks });
    expect(found).toEqual([
      { criterionId: "c2", ref: "npx tsx scripts/counterexample.ts", exitCode: 1 },
      { criterionId: "c2", ref: "npm run typecheck", exitCode: 2 },
    ]);
    expect(found.map(failedCheckWords)).toEqual([
      'criterion "c2"\'s check "npx tsx scripts/counterexample.ts" exited 1',
      'criterion "c2"\'s check "npm run typecheck" exited 2',
    ]);
    // THE SAME FACT the adjudicator's matrix reports for a signed criterion
    // whose required check exited nonzero — one sentence, two readers.
    const proofParse = parse({ ...sound, criteria: [{ ...criteria[1], statement: "The guard rejects a negative payout." }], checks });
    const result = adjudicate({
      ...base,
      proofParse,
      approvedCriteria: [{ id: "c2", statement: "The guard rejects a negative payout.", evidence: ["check"] }],
    });
    expect(result.verdict).toBe("short");
    expect(result.matrix[0]).toMatchObject({ id: "c2", state: "failed" });
    expect(result.matrix[0]!.detail).toContain(failedCheckWords(found[0]!));
    expect(result.reasons).toContain(failedCheckWords(found[0]!));
  });

  test("a proof with no criteria and no verify command still attests when the diff agrees", () => {
    const empty = parse({ version: 1 });
    expect(adjudicate({ ...base, proofParse: empty, diffStat: { captured: true, truncated: false, paths: new Set() } })).toMatchObject({
      verdict: "attested",
    });
  });
});

describe("foldReview (v40, evidence-review-v1)", () => {
  const row = (id: string, state: CriterionMatrixRow["state"] = "pass"): CriterionMatrixRow => ({
    id,
    statement: `statement ${id}`,
    requiredEvidence: ["manual-review"],
    state,
    detail: [],
    answered: [],
    review: null,
  });

  const judgement = (id: string, word: CriterionJudgement["judgement"], note = "note"): CriterionJudgement => ({
    id,
    judgement: word,
    note,
    author: "reviewer:codex",
  });

  test("identity fold: no judgements leaves the result untouched, even against an empty rubric", () => {
    const base: AdjudicateResult = { verdict: "attested", reasons: ["r"], matrix: [] };
    expect(foldReview(base, [])).toEqual(base);
    const withRows: AdjudicateResult = { verdict: "short", reasons: ["r"], matrix: [row("c1", "missing")] };
    expect(foldReview(withRows, [])).toEqual(withRows);
  });

  test("eligible prior support and partial patches never supply a current judgement or waive strict coverage", () => {
    const base: AdjudicateResult = { verdict: "short", reasons: ["gap"], matrix: [{ ...row("c1"), coverage: { state: "gap", inherited: true, items: ["ctx-1"], gaps: ["partial ancestor patch; full file exceeds capture budget"], priorSupport: "eligible" } }] };
    const unchanged = foldReview(base, []);
    expect(unchanged).toEqual(base);
    expect(semanticCoverage(unchanged.matrix, "strict")).toMatchObject({ upheld: [], unreviewed: ["c1"], satisfied: null });
    const uncertain = foldReview(base, [judgement("c1", "cannot-tell")]);
    expect(semanticCoverage(uncertain.matrix, "strict")).toMatchObject({ uncertain: ["c1"], satisfied: false });
    expect(uncertain.verdict).toBe("short");
    expect(uncertain.matrix[0]!.coverage).toEqual(base.matrix[0]!.coverage);
  });

  test("contradicts refutes: a signed criterion a second reader says is unmet fails the whole proof", () => {
    const base: AdjudicateResult = { verdict: "attested", reasons: ["fine"], matrix: [row("c1"), row("c2")] };
    const result = foldReview(base, [judgement("c1", "contradicts", "never implemented")]);
    expect(result.verdict).toBe("refuted");
    const failed = result.matrix.find(r => r.id === "c1");
    expect(failed?.state).toBe("failed");
    expect(failed?.detail.join(" ")).toContain("never implemented");
    expect(failed?.review).toEqual({ judgement: "contradicts", note: "never implemented", author: "reviewer:codex" });
    // an untouched row keeps its own state and gets no review
    expect(result.matrix.find(r => r.id === "c2")).toMatchObject({ state: "pass", review: null });
  });

  test("cannot-tell changes nothing: recorded, never moves the verdict", () => {
    const base: AdjudicateResult = { verdict: "short", reasons: ["gap"], matrix: [row("c1", "missing")] };
    const result = foldReview(base, [judgement("c1", "cannot-tell", "the patch alone cannot settle this")]);
    expect(result.verdict).toBe("short");
    expect(result.reasons).toEqual(base.reasons);
    expect(result.matrix[0]?.state).toBe("missing");
    expect(result.matrix[0]?.review).toEqual({ judgement: "cannot-tell", note: "the patch alone cannot settle this", author: "reviewer:codex" });
  });

  test("upholds never upgrades: a short run stays short", () => {
    const base: AdjudicateResult = { verdict: "short", reasons: ["gap"], matrix: [row("c1", "missing")] };
    const result = foldReview(base, [judgement("c1", "upholds", "looks right to me")]);
    expect(result.verdict).toBe("short");
    expect(result.matrix[0]?.state).toBe("missing");
    expect(result.matrix[0]?.review?.judgement).toBe("upholds");
  });

  test("upholds never upgrades: an attested run stays attested, never verified", () => {
    const base: AdjudicateResult = { verdict: "attested", reasons: ["clean"], matrix: [row("c1")] };
    const result = foldReview(base, [judgement("c1", "upholds")]);
    expect(result.verdict).toBe("attested");
  });

  test("a judgement naming an id absent from the matrix is ignored", () => {
    const base: AdjudicateResult = { verdict: "attested", reasons: ["clean"], matrix: [row("c1")] };
    const result = foldReview(base, [judgement("unsigned-id", "contradicts", "n/a")]);
    expect(result).toEqual(base);
  });
});

describe("passFraction", () => {
  test("counts pass rows against the total", () => {
    const matrix: CriterionMatrixRow[] = [
      { id: "c1", statement: "s", requiredEvidence: [], state: "pass", detail: [], answered: [], review: null },
      { id: "c2", statement: "s", requiredEvidence: [], state: "missing", detail: [], answered: [], review: null },
    ];
    expect(passFraction(matrix)).toEqual({ passed: 1, total: 2 });
  });

  test("an empty matrix is 0/0", () => {
    expect(passFraction([])).toEqual({ passed: 0, total: 0 });
  });
});

describe("verdictWords and dispatchStatusToken", () => {
  test("cover every verdict with distinct words and tokens", () => {
    const verdicts = ["verified", "attested", "short", "refuted"] as const;
    const words = verdicts.map(v => verdictWords(v, ["a reason"]).word);
    expect(new Set(words).size).toBe(verdicts.length);
    const tokens = verdicts.map(dispatchStatusToken);
    expect(tokens).toEqual(["complete-verified", "complete-with-evidence", "needs-verification", "proof-refuted"]);
  });
});

describe("direct assessment of captured evidence", () => {
  const captured = (extra: Partial<AdjudicateInput> = {}): AdjudicateInput => ({
    directAssessment: true, proofArtifactPresent: false, proofParse: null,
    handoffPresent: true, terminalDiffPresent: true, terminalDiffCaptureStatus: "ok",
    diffStat: { captured: true, truncated: false, paths: new Set(["src/save.ts"]) },
    verifyCommand: { configured: true, ran: true, exitCode: 0 }, verificationCommand: "npm test",
    screenshots: [], approvedCriteria: [{ id: "c1", statement: "Saved flags survive reload", evidence: ["check", "changed-path"] }], ...extra,
  });
  const judge = (base: AdjudicateResult, judgement: CriterionJudgement["judgement"] = "upholds") => foldReview(base, [{ id: "c1", judgement, author: "reviewer", note: "src/save.ts and its reload test show the outcome" }]);

  test("green checks await goal assessment even under default quality; only the independent assessment completes it", () => {
    const before = adjudicate(captured());
    expect(before).toMatchObject({ verdict: "short", machineVerdict: "verified", matrix: [{ state: "missing", assessment: { evidenceState: "pass" }, review: null }] });
    expect(passFraction(before.matrix)).toEqual({ passed: 0, total: 1 });
    expect(semanticCoverage(before.matrix, "default")).toMatchObject({ required: true, satisfied: null });
    const after = judge(before);
    expect(after).toMatchObject({ verdict: "verified", machineVerdict: "verified", matrix: [{ state: "pass" }] });
    expect(semanticCoverage(after.matrix, "default")).toMatchObject({ required: true, satisfied: true });
    expect(judge(before, "contradicts").verdict).toBe("refuted");
    expect(judge(before, "cannot-tell").verdict).toBe("short");
  });

  test.each([
    { verifyCommand: { configured: true, ran: true, exitCode: 1 } },
    { verifyCommand: { configured: true, ran: false, attemptFailed: true, failure: "timed-out" } },
    { handoffPresent: false }, { terminalDiffCaptureStatus: "failed" },
    { diffStat: { captured: true, truncated: true, paths: new Set(["src/save.ts"]) } },
  ] as Partial<AdjudicateInput>[])("a review cannot override failed or incomplete machine evidence: %j", extra => {
    const result = judge(adjudicate(captured(extra)));
    expect(["short", "refuted"]).toContain(result.verdict);
    expect(["short", "refuted"]).toContain(result.machineVerdict);
  });

  test.each(["screenshot", "manual-review"] as const)("required %s remains unresolved even with an upholding reviewer", kind => {
    const result = judge(adjudicate(captured({ approvedCriteria: [{ id: "c1", statement: "Inspect the result", evidence: [kind] }] })));
    expect(result.verdict).toBe("short");
    expect(result.matrix[0]?.state).toBe(kind === "screenshot" ? "missing" : "manual-review");
    expect(result.reasons.join(" ")).toContain(kind === "screenshot" ? "captured screenshot" : "an operator must accept");
  });

  test("a bounded screenshot-only inventory needs no duplicated criterion or changed-path claims", () => {
    const input = captured({ proofArtifactPresent: true, proofParse: parse({ version: 1, screenshots: [{ path: "screen.png", caption: "Saved result" }] }),
      screenshots: [{ path: "screen.png", ok: true, bytes: 10000, dims: { width: 800, height: 600 } }],
      approvedCriteria: [{ id: "c1", statement: "The result is readable", evidence: ["screenshot"] }] });
    expect(judge(adjudicate(input)).verdict).toBe("verified");
    expect(adjudicate({ ...input, proofParse: parseProof("malformed") })).toMatchObject({ verdict: "short", reasons: [expect.stringContaining("malformed")] });
  });

  test("a complete empty diff can be assessed; it does not claim a change or a satisfied goal", () => {
    const result = adjudicate(captured({ diffStat: { captured: true, truncated: false, paths: new Set() } }));
    expect(result).toMatchObject({ verdict: "short", machineVerdict: "verified" });
    expect(result.matrix[0]?.answered).toEqual([{ kind: "check", ref: "npm test" }]);
  });
});

describe("reasons in a person's words (records keep their exact text)", () => {
  const manual = 'criterion "c1" requires manual-review evidence — an operator must accept it before this can verify';

  test("a requirement only a person can confirm names the statement, not the id", () => {
    expect(manualReviewCriterionOf(manual)).toBe("c1");
    expect(manualReviewCriterionOf("the approved verification command could not be run")).toBeNull();
    expect(manualReviewOnly({ verdict: "short", reasons: [manual] })).toBe(true);
    expect(personCheckWords("The empty state reads clearly.")).toBe("You check this one: The empty state reads clearly.");
    expect(personCheckWords(null)).toBe("You check this one yourself.");
    expect(plainReasonWords(manual)).toBe("A requirement needs your own check.");
  });

  test("an unassigned caveat and a reviewer's judgement drop the criterion vocabulary", () => {
    const caveat = caveatAttributionWords({ caveat: "Captured against fixtures.", index: 0, kind: "unassigned", tags: [] });
    expect(plainReasonWords(caveat)).toBe("The agent left a note without saying which requirement it affects: Captured against fixtures.");
    expect(plainReasonWords('reviewer:codex contradicts criterion "c1": The diff adds a TODO, not a lock.')).toBe("codex says a requirement is not met: The diff adds a TODO, not a lock.");
    expect(plainReasonWords('Reviewer:codex needs more evidence for criterion "c2": No screenshot.')).toBe("codex isn't sure a requirement is met: No screenshot.");
    for (const words of [plainReasonWords(manual), plainReasonWords(caveat)]) expect(words).not.toMatch(/criterion|evidence|operator|verify/i);
    expect(plainReasonWords("Something else entirely.")).toBe("Something else entirely.");
  });
});
