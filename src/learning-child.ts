/**
 * Started only by learning-look.ts: one project's learning recovery (project-learning.ts acceptedIdentities and
 * recoverLearning) in a process of its own, so its synchronous reads of the project's Git folder can never hold the
 * console's thread. It opens the database without migrating, does that one project, and ends; the console kills it
 * at its deadline. Its one argument is JSON naming the database, the evidence folder and the project.
 */
import { acceptedIdentities, recoverLearning } from "./project-learning.js";
import { openStoreNoMigrate } from "./store.js";

const input = JSON.parse(process.argv[2] ?? "null") as { databaseFile?: unknown; evidenceRoot?: unknown; repo?: unknown } | null;
const text = (value: unknown): value is string => typeof value === "string" && value !== "" && !value.includes("\0");
if (input === null || !text(input.databaseFile) || !text(input.evidenceRoot) || !text(input.repo)) process.exit(2);
const opened = openStoreNoMigrate(input.databaseFile);
if (!opened.ok) process.exit(3);
let code = 0;
try {
  try { acceptedIdentities(opened.store, input.repo); } catch { code = 1; }
  try { recoverLearning(opened.store, input.evidenceRoot, input.repo); } catch { code = 1; }
} finally {
  opened.store.close();
}
process.exit(code);
