/**
 * Mixed outcomes under recorded conditions (docs/plans/learning-loops.md, "Flaky tests"): advisory only. Nothing here
 * changes a check's outcome, a verdict, an approval or a rerun; rerunning stays a person's `task regate`.
 *
 * Slice 1 holds the tracked identities an observation adds (`learning_watch`, reason `observation`): every Full check
 * with a handshake asks about them for 90 days (check-facts.ts learnRequestFor). Lesson notes (lesson-notes.ts) add
 * their own. This module and lesson-notes.ts are the only writers of `learning_watch`; release-auto's learning scan
 * (eval-hooks.ts learningWriteProblem) needs a person for any other. A policy path (release-auto.ts EVAL_POLICY).
 */
import type { Store } from "./store.js";

/** Track an identity a local observation named (one row per observation; first write wins, never rewritten). */
export function watchObservation(store: Store, input: { repo: string; identity: string; observation: number; now: Date }): boolean {
  if (input.repo.trim() === "" || input.identity.length < 1 || input.identity.length > 2600 || !Number.isSafeInteger(input.observation) || input.observation < 1) {
    throw new Error("a tracked identity needs its project, a bounded identity and the observation that named it");
  }
  const added = store.handle.prepare(`INSERT INTO learning_watch (repo, identity, reason, source_ref, since, until) VALUES (?, ?, 'observation', ?, ?, NULL)
    ON CONFLICT (repo, identity, reason, source_ref) DO NOTHING`).run(input.repo, input.identity, `observation:${input.observation}`, input.now.toISOString());
  return Number(added.changes) === 1;
}
