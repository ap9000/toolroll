/**
 * The terminal UI's view of the plane (tui-contract.ts): the screen reads and asks only through a TuiSource and a
 * TuiSession. The real ones are the CLI's (tui-source.ts, easy-start.ts); the sample here is for running the bundle on
 * its own (`node dist/tui.js`), its rows labelled as samples so nobody mistakes them for real agent output.
 */
export type { TuiAct, TuiActResult, TuiDecision, TuiExit, TuiRow, TuiSession, TuiSetup, TuiSnapshot, TuiSource, TuiTask } from "../tui-contract.js";
import type { TuiRow, TuiSession, TuiSource, TuiTask } from "../tui-contract.js";

/** A sample plane that changes nothing: every write is refused with words that say so. */
export function sampleSource(): TuiSource {
  const rows: TuiRow[] = [
    { id: "t1", title: "Sample: fix the login redirect", status: "Running", detail: "Sample task (not real)", needsYou: false, liveRunId: 1, repo: null },
    { id: "t2", title: "Sample: add CSV export", status: "Ready", detail: "Sample task (not real)", needsYou: false, liveRunId: null, repo: null },
    { id: "t3", title: "Sample: upgrade the test runner", status: "Needs you", detail: "Plan ready to approve", needsYou: true, liveRunId: null, repo: null },
  ];
  return {
    snapshot: async () => ({ rows, needsYou: "1 task needs you: Sample: upgrade the test runner", projects: [], passwordSet: false }),
    task: async id => {
      const row = rows.find(one => one.id === id);
      if (row === undefined) return null;
      const task: TuiTask = { id, title: row.title, status: row.status, detail: row.detail, liveRunId: row.liveRunId, hasResult: row.status === "Ready", decisions: [],
        plan: row.needsYou ? { digest: "sample", lines: ["Goal: upgrade the test runner (sample)"] } : null };
      return task;
    },
    live: id => (id === "t1" ? ["Editing src/auth.ts (sample)"] : []),
    changed: () => 0,
    act: async () => ({ ok: false, message: "This is a sample: nothing changes.", needsPassword: false }),
    setup: async () => null,
  };
}

export function sampleSession(): TuiSession {
  return { owned: () => false, openBrowser: async () => "This is a sample.", shouldAskBackground: () => false, answerBackground: async () => "This is a sample." };
}
