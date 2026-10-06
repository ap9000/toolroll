/**
 * The 15 real evidence samples in test/fixtures/evidence/run-<id>/ (handoff.json, proof.json and
 * verification-receipt.json where the run had one; scrubbed of the home path, machine and tailnet names and the
 * owner's email) and what the parsers before the Zod contracts made of them, recorded in baseline.json before those
 * parsers were replaced. `adjudications` is the same set of facts the baseline was recorded with.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { adjudicate, type AdjudicateInput, type AdjudicateResult, type ApprovedCriterion, type ProofParseResult } from "../src/proof.js";

const root = fileURLToPath(new URL("./fixtures/evidence/", import.meta.url));

export type EvidenceSample = { run: string; handoff: string | null; proof: string | null; receipt: string | null };

export const evidenceSamples: EvidenceSample[] = readdirSync(root)
  .filter(name => name.startsWith("run-"))
  .sort()
  .map(run => {
    const read = (name: string) => (existsSync(join(root, run, name)) ? readFileSync(join(root, run, name), "utf8") : null);
    return { run, handoff: read("handoff.json"), proof: read("proof.json"), receipt: read("verification-receipt.json") };
  });

export type EvidenceBaseline = {
  proof: ProofParseResult | null;
  handoff: Record<string, unknown> | null;
  receipt: { bytes: string; sha256: string } | null;
  adjudication: Record<string, AdjudicateResult>;
};

export const evidenceBaseline = JSON.parse(readFileSync(join(root, "baseline.json"), "utf8")) as Record<string, EvidenceBaseline>;

const RUBRIC: ApprovedCriterion[] = [
  { id: "c1", statement: "The change works.", evidence: ["check"] },
  { id: "c2", statement: "The page shows it.", evidence: ["screenshot"] },
];

/** Adjudicate one sample's proof parse under the five sets of facts the baseline recorded. */
export function adjudications(proofParse: ProofParseResult | null, receiptRaw: string | null): Record<string, AdjudicateResult> {
  const receipt = receiptRaw === null ? null : (JSON.parse(receiptRaw) as { result: AdjudicateInput["verifyCommand"]; command: { command: string } });
  const shots = proofParse?.ok ? proofParse.proof.screenshots : [];
  const changed = proofParse?.ok ? proofParse.proof.changed : [];
  const shown = (path: string) => ({ path, ok: true, bytes: 50_000 });
  const base: AdjudicateInput = {
    proofArtifactPresent: proofParse !== null, proofParse, handoffPresent: true, terminalDiffPresent: true, terminalDiffCaptureStatus: "ok",
    diffStat: { captured: true, truncated: false, paths: new Set(changed.length ? changed : ["src/x.ts"]) },
    verifyCommand: receipt?.result ?? { configured: false },
    screenshots: shots.map(one => shown(one.path)),
  };
  return {
    plain: adjudicate(base),
    direct: adjudicate({ ...base, directAssessment: true, ...(receipt === null ? {} : { verificationCommand: receipt.command.command }) }),
    rubric: adjudicate({ ...base, approvedCriteria: RUBRIC }),
    directRubric: adjudicate({ ...base, directAssessment: true, approvedCriteria: RUBRIC }),
    missingShot: adjudicate({ ...base, screenshots: shots.map((one, index) => (index === 0 ? { path: one.path, ok: false as const, problem: "the file does not exist" } : shown(one.path))) }),
  };
}
