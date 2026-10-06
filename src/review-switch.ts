/** The per-project automatic review switch and the one review each finished
 * build gets (build-review.ts runs it): tables, and the read-only views every
 * surface shows. No schema version bump. Kept free of heavy imports so the
 * status readers can use it without an import cycle. */
import type { BuildFinding } from "./contracts/review-findings.js";
import type { Store } from "./store.js";

/** One automatic-review finding: how bad, where, and how it fails (src/contracts/review-findings.ts). */
export type { BuildFinding, FindingSeverity } from "./contracts/review-findings.js";

export const REVIEW_SCHEMA = `
-- A project's explicit review switch. No row: on while the project is under a hands-off mode, off otherwise.
CREATE TABLE IF NOT EXISTS review_switch (
  repo        TEXT PRIMARY KEY,
  enabled     INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  changed_by  TEXT NOT NULL,
  changed_at  TEXT NOT NULL
);
-- One row per reviewed build run: pending until its one reviewer run settles it.
CREATE TABLE IF NOT EXISTS build_review (
  run           INTEGER PRIMARY KEY,
  task_id       TEXT NOT NULL,
  repo          TEXT NOT NULL,
  state         TEXT NOT NULL CHECK (state IN ('pending', 'reviewed', 'not-reviewed')),
  request       INTEGER,
  reviewer_run  INTEGER,
  findings_json TEXT,
  reason        TEXT,
  sent_back_as  TEXT,
  queued_at     TEXT NOT NULL,
  finished_at   TEXT
);
CREATE INDEX IF NOT EXISTS build_review_pending ON build_review (repo) WHERE state = 'pending';
CREATE INDEX IF NOT EXISTS build_review_sent_back ON build_review (sent_back_as) WHERE sent_back_as IS NOT NULL;
`;

export type ReviewSwitch = { on: boolean; source: "project" | "hands-off" | "default"; changedBy: string | null; changedAt: string | null };

/** How the policy log words a switch state. */
export function reviewSwitchWords(state: ReviewSwitch): string {
  return state.source === "project" ? (state.on ? "on" : "off") : state.on ? "on (hands-off default)" : "off (default)";
}

export type BuildReviewView = {
  run: number;
  state: "pending" | "reviewed" | "not-reviewed";
  reviewerRun: number | null;
  /** Why it was not reviewed, in words. */
  reason: string | null;
  /** HIGH findings; they sent the task back when `sentBackAs` is set. */
  high: BuildFinding[];
  /** MEDIUM and LOW findings: suggested follow-ups, never blocking. */
  followUps: BuildFinding[];
  sentBackAs: string | null;
  finishedAt: string | null;
};

export function buildReviewOf(store: Pick<Store, "handle">, runId: number): BuildReviewView | null {
  let row: Record<string, unknown> | undefined;
  // A deploy reads this with the candidate's code over the INSTALLED runtime's file, before this version's migration
  // made the table: no table reads as no review.
  try { row = store.handle.prepare("SELECT * FROM build_review WHERE run = ?").get(runId); }
  catch (error) { if (/no such table: build_review/.test(String(error))) return null; throw error; }
  if (row === undefined) return null;
  // The row was validated when it was written (parseBuildFindings).
  let findings: BuildFinding[] = [];
  try {
    const saved = row["findings_json"] === null ? null : JSON.parse(String(row["findings_json"])) as { findings?: unknown };
    if (Array.isArray(saved?.findings)) findings = saved.findings as BuildFinding[];
  } catch { /* An unreadable saved row shows no findings; its state stays. */ }
  return {
    run: runId,
    state: String(row["state"]) as BuildReviewView["state"],
    reviewerRun: row["reviewer_run"] === null ? null : Number(row["reviewer_run"]),
    reason: row["reason"] === null ? null : String(row["reason"]),
    high: findings.filter(one => one.severity === "HIGH"),
    followUps: findings.filter(one => one.severity !== "HIGH"),
    sentBackAs: row["sent_back_as"] === null ? null : String(row["sent_back_as"]),
    finishedAt: row["finished_at"] === null ? null : String(row["finished_at"]),
  };
}

export const findingWords = (finding: BuildFinding): string => `${finding.severity} ${finding.file}:${finding.line} — ${finding.scenario}`;

/** The review's standing in one line, or null while nothing was asked. */
export function buildReviewHeadline(view: BuildReviewView | null): string | null {
  if (view === null) return null;
  if (view.state === "pending") return "Reviewing — an automatic review is reading this result.";
  if (view.state === "not-reviewed") return `Not reviewed${view.reason === null ? "." : `: ${view.reason}`}`;
  if (view.sentBackAs !== null) return `Sent back as ${view.sentBackAs}: ${view.high.length} high finding${view.high.length === 1 ? "" : "s"}.`;
  if (view.high.length > 0) return `Reviewed: ${view.high.length} high finding${view.high.length === 1 ? "" : "s"} for you to decide.`;
  return `Reviewed: no high findings${view.followUps.length === 0 ? "." : `; ${view.followUps.length} suggested follow-up${view.followUps.length === 1 ? "" : "s"}.`}`;
}

/** Plain lines for `task show` and `assignment show`. */
export function buildReviewLines(view: BuildReviewView | null): string[] {
  const headline = buildReviewHeadline(view);
  if (view === null || headline === null) return [];
  return [
    `  review: ${headline}`,
    ...view.high.map(one => `    ${findingWords(one)}`),
    ...view.followUps.map(one => `    suggested follow-up: ${findingWords(one)}`),
  ];
}
