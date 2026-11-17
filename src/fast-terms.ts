/** A fast start's terms, the words a yes agrees to (scope.ts describeScope, the lines every plan approval reads), plus the
 * project tools its seal will carry. The same lines on the New task form, in the terminal UI and in `task new`. The
 * plan version and approval state rows say nothing yet: nothing is approved. */
import type { Scope } from "./scope.js";
import { describeScope, summaryContextOf } from "./approval-summary.js";
import type { Store } from "./store.js";

const LABELS: Readonly<Record<string, string>> = { goal: "Goal", "not this": "Not this", files: "Files", budget: "Budget", network: "Network", writes: "Writes", reads: "Reads", checks: "Checks", services: "Services" };

export function fastTermsLines(store: Store, scope: Scope, repo: string): { label: string; words: string }[] {
  const lines = termsOfLines(describeScope(scope, undefined, null, summaryContextOf(store, scope.taskId, scope, new Date(), null, repo)));
  const tools = store.projectTools(repo).map(one => one.name);
  lines.push({ label: "Project tools", words: tools.length === 0 ? "None" : tools.join(", ") });
  return lines;
}

/** Terms lines (approval-summary.ts summaryLines, or describeScope's) as rows: each `  Label   words` line a row, an
 * indented line under it part of that row (a new line in its words). The plan version and approval state lines are left
 * out: they are no term. Build's offer and the workbench's approval card read their terms this one way. */
export function termsOfLines(raw: readonly string[]): { label: string; words: string }[] {
  const lines: { label: string; words: string }[] = [];
  for (const one of raw) {
    const line = one.trimEnd();
    const named = /^ {2}(\S+(?: \S+)?) {2,}(.*)$/.exec(line);
    if (named !== null && (named[1] === "version" || named[1] === "approved")) continue;
    if (named !== null) lines.push({ label: LABELS[named[1]!] ?? `${named[1]![0]!.toUpperCase()}${named[1]!.slice(1)}`, words: named[2]! });
    else if (lines.length > 0) lines[lines.length - 1]!.words += `\n${line.trim()}`;
    else lines.push({ label: "Plan", words: line.trim() });
  }
  return lines;
}
