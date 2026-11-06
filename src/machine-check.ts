/** A check the machine runs, said as what it is (docs/plans/plain-toolroll.md, Phase 1 follow-up from a release's own
 * page): a task with a prepared candidate is checked out by the machine and no agent runs, so its status says the check
 * that is running, its step and its progress, from the check's own records, never "an agent", and it has no notes to
 * read and no word to send. Presentation only: it reads the run, its check progress and the release's steps. */
import type { Store } from "./store.js";

/** The words for a machine-run check now running on `runId`, or null when an agent builds this task (or nothing runs). */
export function machineCheckWords(store: Store, taskId: string, runId: number | null, release: { at?: { step: string; name: string; index: number; of: number } | null } | null, now: Date): string | null {
  if (runId === null || store.getScope(taskId)?.candidate == null) return null;
  const run = store.getRun(runId);
  if (run === null || run.outcome !== null || run.finishedAt !== null) return null;
  let progress: string | null = null;
  try { progress = store.checkProgress(runId)?.line ?? null; } catch { progress = null; }
  const started = Date.parse(run.startedAt);
  const minutes = Number.isFinite(started) ? Math.max(0, Math.floor((now.getTime() - started) / 60_000)) : null;
  const elapsed = minutes === null ? "" : minutes < 1 ? " · started just now" : ` · ${minutes} min`;
  const at = release?.at ?? null;
  const head = at === null ? "Running the project check on the prepared version"
    : at.step === "check" ? `Running the release check · step ${at.index} of ${at.of}` : `${at.name} · step ${at.index} of ${at.of}`;
  return `${head}${progress === null || progress === "" ? "" : ` · ${progress}`}${elapsed}`;
}

/** Whether this task's builds are the machine's own checks (a prepared candidate), where no agent runs. */
export function machineChecked(store: Store, taskId: string): boolean {
  return store.getScope(taskId)?.candidate != null;
}
