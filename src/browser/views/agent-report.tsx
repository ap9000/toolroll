/** One-workspace S5: what the agent says about its own work, and what a person said, read before deciding.
 *
 * The agent's lines (what it left undone, the risks it sees, its decisions and assumptions) are agent-written: shown as
 * plain text under "The agent says", never a link, never markup, never a check. A list it didn't fill is said as "didn't
 * report", never as "none". "You said" quotes only words a signed-in person typed for this version (store
 * typedNotesFor), each with its author — the viewer's own as "You", anyone else's by name — and when. */
import { KChip, KDisclose, KNote } from "../kit/index.js";
import type { BrowserResultView } from "../../browser-workspace.js";
import { threadWhen, whenTitle } from "./task-view.js";

type Selected = NonNullable<BrowserResultView["selected"]>;
type Report = NonNullable<Selected["agentReport"]>;
type Said = NonNullable<Selected["youSaid"]>[number];

/** Decisions and assumptions shown before the rest fold; what's undone and every risk always show. */
export const REPORT_SHOWN = 3;
/** Quotes shown before the rest fold. */
export const SAID_SHOWN = 2;

type Line = { tag: string; text: string };

/** The agent's lines, in reading order: what it left undone and the risks first (they matter before Accept), then its
 * decisions and assumptions. */
export function reportLines(report: Report): { always: Line[]; more: Line[] } {
  return {
    always: [...report.notDone.map(text => ({ tag: "Not done", text })), ...report.risks.map(text => ({ tag: "Risk", text }))],
    more: [...report.decisions.map(text => ({ tag: "Decided", text })), ...report.assumptions.map(text => ({ tag: "Assumed", text }))],
  };
}

/** The quiet line for what the agent didn't report: null when it reported both kinds. */
export function unreportedWords(report: Report): string | null {
  const choices = report.decisions.length + report.assumptions.length > 0;
  const risks = report.notDone.length + report.risks.length > 0;
  return !choices && !risks ? "The agent didn't report decisions or risks." : !risks ? "The agent didn't report risks." : null;
}

function ReportLine({ line }: { line: Line }) {
  return <li className="so-report-line" data-agent-says={line.tag}><KChip word={line.tag} dot={false} /><span className="so-report-text">{line.text}</span></li>;
}

function SaidLine({ one }: { one: Said }) {
  return <li className="so-report-line" data-you-said={one.you ? "you" : "other"}>
    <span className="so-report-quote"><bdi>“{one.note}”</bdi></span>
    <span className="k-note">{one.you ? "You" : <bdi>{one.author}</bdi>} · <time dateTime={one.at} title={whenTitle(one.at)}>{threadWhen(one.at)}</time>
      {" · "}{one.kind === "sent-back" ? "sent back" : "note to the agent"}</span>
  </li>;
}

/** The section itself; nothing at all when there is no finished build to report on. */
export function AgentReport({ report, said }: { report: Selected["agentReport"]; said: Selected["youSaid"] }) {
  if (report == null) return null;
  const quotes = said ?? [];
  const { always, more } = reportLines(report);
  const shown = more.slice(0, REPORT_SHOWN), folded = more.slice(REPORT_SHOWN);
  const quiet = unreportedWords(report);
  const reported = always.length + more.length > 0;
  const yours = quotes.every(one => one.you);
  return <section className="k-sec so-report" aria-label="Decisions, risks and notes" data-agent-report={reported ? "reported" : "none"}>
    {reported && <h3>The agent says</h3>}
    {reported && <ul className="so-report-lines">
      {always.map((line, at) => <ReportLine key={`a${at}`} line={line} />)}
      {shown.map((line, at) => <ReportLine key={`m${at}`} line={line} />)}
    </ul>}
    {folded.length > 0 && <KDisclose summary={`${folded.length} more`}><ul className="so-report-lines">{folded.map((line, at) => <ReportLine key={at} line={line} />)}</ul></KDisclose>}
    {quiet !== null && <KNote>{quiet}</KNote>}
    {quotes.length > 0 && <>
      <h3>{yours ? "You said" : "People said"}</h3>
      <ul className="so-report-lines" data-you-said-count={quotes.length}>{quotes.slice(0, SAID_SHOWN).map(one => <SaidLine key={`${one.kind}${one.at}${one.note}`} one={one} />)}</ul>
      {quotes.length > SAID_SHOWN && <KDisclose summary={`${quotes.length - SAID_SHOWN} more`}><ul className="so-report-lines">
        {quotes.slice(SAID_SHOWN).map(one => <SaidLine key={`${one.kind}${one.at}${one.note}`} one={one} />)}</ul></KDisclose>}
    </>}
  </section>;
}
