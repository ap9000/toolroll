import { adjudicate, parseProof, type ScreenshotOutcome } from "../src/proof.js";

/** The legacy validator records missing before failed; keep its real mixed-evidence output. */
export function mixedCheckScreenshot(shot: ScreenshotOutcome | null) {
  const statement = "The checkout total remains readable on a phone";
  const path = "evidence/checkout.png";
  return adjudicate({
    proofArtifactPresent: true,
    proofParse: parseProof(JSON.stringify({ version: 1, criteria: [{ id: "c1", statement, verdict: "met", how: "Inspect checkout",
      evidence: [{ kind: "screenshot", ref: path }] }], screenshots: [{ path, caption: "Checkout" }] })),
    handoffPresent: true, terminalDiffPresent: true, terminalDiffCaptureStatus: "ok",
    diffStat: { captured: true, truncated: false, paths: new Set() }, verifyCommand: { configured: false },
    screenshots: shot === null ? [] : [{ ...shot, path }],
    approvedCriteria: [{ id: "c1", statement, evidence: ["check", "screenshot"] }],
  }).matrix[0]!;
}
