/** A complete handoff artifact for tests that only care about a few of its fields: the rest are plain defaults. */
import { HANDOFF_VERSION, type HandoffArtifact } from "../src/contracts/handoff.js";

export function handoffFixture(runId: number, fields: Partial<Omit<HandoffArtifact, "version" | "runId">> = {}): HandoffArtifact {
  return {
    version: HANDOFF_VERSION,
    taskId: "task",
    runId,
    provider: "claude",
    sessionId: null,
    branch: "standing-orders/task",
    worktree: "/pool/task",
    base: "a".repeat(40),
    head: "b".repeat(40),
    outcome: "built",
    committed: true,
    decisionsIncorporated: [],
    conclusion: "Finished.",
    freshness: { stampedAt: "2026-10-05T00:00:00.000Z", currentAsOf: "b".repeat(40) },
    ...fields,
  };
}

/** The fixture's stored bytes. */
export const handoffBytes = (runId: number, fields: Partial<Omit<HandoffArtifact, "version" | "runId">> = {}) => Buffer.from(JSON.stringify(handoffFixture(runId, fields)), "utf8");
