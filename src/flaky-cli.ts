/** `toolroll flaky list|show`: the flaky tests list from the terminal, read only. Rerunning stays `task regate`; fixing
 * one is an ordinary task a person approves (`show` prints it). Nothing here starts a model or changes anything. */
import { envelopeJson } from "./envelope.js";
import { FLAKY_WINDOW_DAYS, flakyList, flakyShow, type FlakyList, type FlakyRow } from "./flaky.js";
import type { Store } from "./store.js";

const flags = [
  { name: "repo", takesValue: true, meaning: "admitted project checkout root" },
  { name: "days", takesValue: true, meaning: `how far back to look (default ${FLAKY_WINDOW_DAYS})` },
  { name: "json", takesValue: false, meaning: "versioned structured response" },
  { name: "db", takesValue: true, meaning: "local Toolroll database" },
] as const;
export const FLAKY_DESCRIPTORS = [
  { action: "list", synopsis: "tests with mixed outcomes under recorded conditions (read only)", mutation: "none", takesQuery: false, flags },
  { action: "show", synopsis: "one row's history, and the task that would fix it: flaky show <identity> (read only)", mutation: "none", takesQuery: true, flags },
] as const;
export type FlakyCliContext = { store: Store; write: (line: string) => void; json: boolean; now: Date; actor: string | null; repos: readonly string[] };

const day = (iso: string): string => iso.slice(0, 10);
/** A row's one line of status, the same words the page says. */
export function flakyStatusWords(row: FlakyRow): string {
  return row.status === "mixed outcomes" ? "Mixed outcomes" : row.status === "no failures since its file changed" ? "No failures since its file changed" : "Not enough recorded history";
}
/** How much of the window had per-test reporting, said plainly. */
export function flakyCoverageWords(list: FlakyList): string {
  const checks = list.reported + list.unreported;
  return `Reported by ${list.reported} of ${checks} check${checks === 1 ? "" : "s"}${list.unreported === 0 ? "" : `; ${list.unreported} had no per-test reporting`}.`;
}
const rowLine = (row: FlakyRow): string => `${row.name}\n  ${flakyStatusWords(row)} · ${row.observations} in window · last seen ${day(row.lastSeen)} · ${row.conditions.join(", ") || "conditions not recorded"} · ${row.hardFailures} hard failure${row.hardFailures === 1 ? "" : "s"} · ${row.sources.join(", ") || "no source recorded"}${row.fileChanged === null ? "" : ` · file changed ${day(row.fileChanged)}`}\n  ${row.key}`;

export function runFlakyCommand(positional: readonly string[], options: Map<string, string | true>, context: FlakyCliContext): number {
  const action = positional[0];
  const command = action ? `flaky ${action}` : "flaky";
  const fail = (reason: "usage" | "unauthenticated" | "not-found", message: string) => { context.write(context.json ? envelopeJson({ ok: false, command, reason, message }) : message); return reason === "usage" ? 2 : 1; };
  const ok = (result: Record<string, unknown>, lines: string[]) => { context.write(context.json ? envelopeJson({ ok: true, command, ...result }) : lines.join("\n")); return 0; };
  if (!FLAKY_DESCRIPTORS.some(one => one.action === action)) return fail("usage", "Use flaky list | show <identity> [--repo PATH] [--days N].");
  if (context.actor === null) return fail("unauthenticated", "Sign in first: the remembered local login drives flaky commands.");
  const given = options.get("repo");
  const repo = typeof given === "string" ? given : context.repos.length === 1 ? context.repos[0]! : null;
  if (repo === null) return fail("usage", "Use --repo with the project checkout root.");
  if (!context.repos.includes(repo)) return fail("not-found", "That project is outside your access.");
  const daysGiven = options.get("days");
  const days = typeof daysGiven === "string" ? Number(daysGiven) : FLAKY_WINDOW_DAYS;
  if (!Number.isSafeInteger(days) || days < 1 || days > 730) return fail("usage", "--days takes a whole number from 1 to 730.");
  if (action === "list") {
    const list = flakyList(context.store, repo, context.now, days);
    const history = list.complete ? [] : [`Not enough recorded history: test results are kept for 180 days, so ${days} days can't be counted in full.`];
    if (list.rows.length === 0) return ok({ list }, [...history, ...(list.complete ? ["No mixed outcomes recorded."] : []), flakyCoverageWords(list)]);
    return ok({ list }, ["Mixed outcomes under recorded conditions", ...history, ...list.rows.map(rowLine), flakyCoverageWords(list), ...(list.notPaired === 0 ? [] : [`${list.notPaired} GitHub attempt pairing${list.notPaired === 1 ? "" : "s"} not paired.`]), "Not recorded: network, other processes, time of day."]);
  }
  const key = positional.slice(1).join(" ").trim();
  if (key === "") return fail("usage", "flaky show <identity from flaky list>");
  const found = flakyShow(context.store, repo, key, context.now, days);
  if (found === null) return fail("not-found", "Nothing is recorded for that test in this project.");
  return ok(found, [rowLine(found.row), ...found.history.map(one => `  ${day(one.at)} ${one.failed} failed, ${one.passed} passed · ${one.commit ?? "commit not recorded"} · ${one.conditions}`),
    `Make a task to fix it: toolroll task add "${found.fix.title.replaceAll('"', "'")}" --goal "${found.fix.goal.replaceAll('"', "'")}" --repo ${repo}`]);
}
