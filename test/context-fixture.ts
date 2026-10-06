/** Rows the pre-revamp code (0.9.36) saved for project knowledge, decisions, skills and the memory pass: read-only
 * copies from synthetic data (test/fixtures/context/saved-rows.json), shared by the Item 9 contract tests. */
import { readFileSync } from "node:fs";

type Payload = { payload: string; sha: string };

export type SavedRows = {
  knowledge: { current: (Payload & { revision: number })[]; changes: (Payload & { revision: number })[]; snapshots: (Payload & { run: number | null; identity: string })[] };
  decisions: {
    rows: { id: number; repo: string; revision: number; claim: string; why: string; status: string; supersedes: number | null; decided_by: string; decided_at: string; source_kind: string; source_ref: string | null; recorded_by: string; sha: string }[];
    changes: (Payload & { decision: number; revision: number; action: string })[];
  };
  skills: { packages: Payload[]; changes: (Payload & { revision: number })[]; snapshots: (Payload & { run: number | null })[] };
  memory: { verdicts: { id: string; verdict: string }[]; proposals: { kind: string; fingerprint: string; title: string; rationale: string; before_text: string | null; after_text: string; evidence: string; sessions: number }[] };
};

export const savedRows = JSON.parse(readFileSync(new URL("./fixtures/context/saved-rows.json", import.meta.url), "utf8")) as SavedRows;
