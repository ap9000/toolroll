/**
 * The terminal UI's only view of the plane: a read-only seam. Wave 0a (the Ink spike) feeds it fake rows; the real
 * source (task list/show, status envelopes, agents live) arrives with the TUI wiring wave and must keep this shape.
 */

/** One row of the list pane and what the detail pane shows for it. */
export interface TuiItem {
  readonly id: string;
  readonly title: string;
  /** One short status word, as the board says it (Running, Ready, Needs you, Failed). */
  readonly status: string;
  readonly detail: readonly string[];
}

/** What the screen reads. Synchronous and side-effect free: the screen never writes through it. */
export interface TuiData {
  items(): readonly TuiItem[];
}

/** Placeholder rows for the spike. Labelled as a sample so nobody mistakes them for real agent output. */
export function sampleData(): TuiData {
  const rows: readonly TuiItem[] = [
    { id: "t1", title: "Sample: fix the login redirect", status: "Running", detail: ["Sample task (not real)", "Agent: claude", "Editing src/auth.ts"] },
    { id: "t2", title: "Sample: add CSV export", status: "Ready", detail: ["Sample task (not real)", "Checks passed", "Waiting for your review"] },
    { id: "t3", title: "Sample: upgrade the test runner", status: "Needs you", detail: ["Sample task (not real)", "Plan ready to approve"] },
  ];
  return { items: () => rows };
}
