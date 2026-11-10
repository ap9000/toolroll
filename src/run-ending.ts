/**
 * How a run ended, asked one way.
 *
 * "Interrupted" is stored in two spellings. Every ending written today is the outcome `failed` with the reason
 * `interrupted`. Rows written between schema 25 and 114 carry the outcome `interrupted` itself (a held session cut
 * down mid-flight) and still read. A check that knows only one spelling treats the same event two ways, so every check
 * asks here.
 */
export function wasInterrupted(run: { outcome: string | null; reason?: string | null }): boolean {
  return run.outcome === "interrupted" || (run.outcome === "failed" && run.reason === "interrupted");
}

/**
 * The spelling written today, and only it. The roads that hand an interrupted attempt's draft to the next attempt
 * (salvage in the checkout, the recovery grant, the check a run never reached) ask this one: they were built for the
 * runs that write it, and reading the old spelling there would widen what they recover.
 */
export function endedInterrupted(run: { outcome: unknown; reason?: unknown }): boolean {
  return run.outcome === "failed" && run.reason === "interrupted";
}
