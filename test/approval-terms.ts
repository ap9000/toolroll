/** The approval summary's key for a task as it reads now (approval-summary.ts): what a scripted `task approve` names
 * with `--terms`, as a person would copy it from `task approve <id>`. Opens its own read of the database. */
import { openStore } from "../src/store.js";
import { approvalSummaryFor } from "../src/approval-summary.js";

export function termsArgs(databaseFile: string, taskId: string): string[] {
  const store = openStore(databaseFile);
  try { return ["--terms", approvalSummaryFor(store, taskId, new Date())?.key ?? "none"]; } finally { store.close(); }
}
