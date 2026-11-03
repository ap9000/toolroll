/**
 * Settings → Retention (v105): how long each kind of data is kept, and what
 * the next daily sweep would remove. An instance operator's page; changes
 * take a step-up. Built from the revamp kit; the Settings frame adds the title.
 */
import { html, joinHtml, type Html } from "./html.js";
import { bytesWords } from "./storage.js";
import { RETENTION_KINDS, countWords, periodChoices, periodLabel, type RetentionCount, type RetentionKind, type RetentionPeriods } from "./retention.js";
import { formRow, infoLine, note, notice, select, settingsSection } from "./server/kit.js";
import { kitSectionForm } from "./settings-kit.js";

/** The page is kit pieces now; nothing of the old look is left. Kept as an export for the shared stylesheet. */
export const RETENTION_CSS = "";

/** `chosen`: the kinds someone chose a period for; the rest keep their default. */
export type RetentionView = { periods: RetentionPeriods; chosen: readonly RetentionKind[]; next: RetentionCount[]; lastSweep: string | null; csrf: string };

const listWords = (parts: string[]) => parts.length < 2 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;

/** The next sweep in a line: what goes and about how much space, or that nothing is due. */
function nextWords(view: RetentionView): string {
  if (RETENTION_KINDS.every(({ kind }) => view.periods[kind] === null)) return "Everything is kept forever.";
  const due = view.next.filter(one => one.count > 0);
  if (due.length === 0) return "Nothing is old enough to remove yet.";
  const bytes = due.reduce((sum, one) => sum + one.bytes, 0);
  return `The next daily sweep removes ${listWords(due.map(countWords))} (about ${bytesWords(bytes)}).`;
}

export function retentionHtml(view: RetentionView, said: { said?: string | null; problem?: string | null }): Html {
  const rows = RETENTION_KINDS.map(({ kind, label, detail }) => {
    const current = view.periods[kind];
    const chosen = view.chosen.includes(kind);
    const items = periodChoices(kind, current).map(days => [days === null ? "forever" : String(days), periodLabel(kind, days, chosen || days !== current)] as const);
    return formRow(label, detail, select({ id: `keep-${kind}`, name: kind, label, current: current === null ? "forever" : String(current), items }), "inline");
  });
  const last = view.lastSweep === null ? "" : ` Last sweep ${view.lastSweep.slice(0, 10)}.`;
  return settingsSection({ id: "retention", title: "How long data is kept", lead: html`<span data-retention-next>${nextWords(view)}${last}</span>`,
    body: joinHtml([
      said.problem ? notice(said.problem) : said.said ? infoLine(said.said) : "",
      kitSectionForm({ proof: "retention", action: "/settings/retention", id: "retention-form", gate: true, body: joinHtml(rows) }),
      note("Never removed: the action ledger, and anything a task still needs (unfinished tasks, results Ready for review, anything on hold)."),
    ]) });
}
