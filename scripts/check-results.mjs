/**
 * Results on fd 3 (docs/plans/release-once.md, "How results travel"): a harness process the release check started
 * writes one JSON line per result to fd 3, a pipe only its parent holds. Nothing is written to disk, and nothing is
 * written at all unless the parent said fd 3 is its pipe (TOOLROLL_CHECK_RESULTS_FD=3) and fd 3 is one.
 */
import { fstatSync, writeSync } from "node:fs";

export const resultsEnabled = (() => {
  if (process.env.TOOLROLL_CHECK_RESULTS_FD !== "3") return false;
  try { const fd = fstatSync(3); return fd.isFIFO() || fd.isSocket(); } catch { return false; }
})();

/** Write one result line to the parent's pipe (when there is one). */
export function result(line) {
  if (!resultsEnabled) return;
  try { writeSync(3, `${JSON.stringify(line)}\n`); } catch { /* the parent went away: its own end decides */ }
}
