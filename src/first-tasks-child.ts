/**
 * Started only by learning-look.ts: one project's first-task suggestions (first-run.ts findFirstTasks), in a process
 * of its own so the hardened git's synchronous reads of the project's folder never hold the console's thread. Its one
 * argument is JSON naming the project; it prints the suggestions as JSON and ends.
 */
import { findFirstTasks } from "./first-run.js";

const input = JSON.parse(process.argv[2] ?? "null") as { repo?: unknown } | null;
if (input === null || typeof input.repo !== "string" || input.repo === "" || input.repo.includes("\0")) process.exit(2);
const found = await findFirstTasks(input.repo);
process.stdout.write(JSON.stringify(found), () => process.exit(0));
