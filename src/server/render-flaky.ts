/**
 * The flaky tests list (docs/plans/learning-loops.md, "The list"): a project's tests with mixed outcomes under recorded
 * conditions, on the kit. Reads only; the one action is "Make a task to fix it", the ordinary /tasks/add form, and a
 * person approves that task as usual. Test names are candidate-written text, escaped at the sink like everything else.
 */
import { flakyCoverageWords, flakyStatusWords } from "../flaky-cli.js";
import { fixTaskOf, type FlakyList, type FlakyObservation, type FlakyRow } from "../flaky.js";
import { html, joinHtml, postForm, type Html } from "../html.js";
import { type Chrome, relativeAge, screen, type Screen } from "./chrome.js";
import { btn, chip, disclose, doc, docHeader, empty, facts, note, phoneHeader, row } from "./kit.js";

const KIND_WORDS: Readonly<Record<FlakyObservation["kind"], string>> = { regate: "Checks run again on the same commit", "same-tree": "Two checks of the same code", "in-check-retry": "Passed on a retry inside one check", github: "GitHub re-run" };

/** "Make a task to fix it": the ordinary task form, filled in. */
function fixForm(repo: string, data: FlakyRow, returnTo: string): Html {
  const task = fixTaskOf(data);
  return postForm("/tasks/add", btn("Make a task to fix it", { sm: true, type: "submit" }), { returnTo, hidden: { title: task.title, goal: task.goal, repo } });
}
const statusChip = (data: FlakyRow): Html => chip(flakyStatusWords(data), "", { dot: false });

/** The list. */
export function flakyPage(chrome: Chrome, data: { name: string; repo: string; back: string; selfHref: string; list: FlakyList; now: Date }): Screen {
  const { list } = data;
  const rowHref = (key: string): string => `${data.selfHref}${data.selfHref.includes("?") ? "&" : "?"}row=${encodeURIComponent(key)}`;
  const rows = list.rows.map(one => row({
    href: rowHref(one.key), chip: statusChip(one), title: one.name,
    desc: `${one.observations} in ${list.days} days · ${one.conditions.join(", ") || "conditions not recorded"} · ${one.hardFailures} hard failure${one.hardFailures === 1 ? "" : "s"} · ${one.sources.join(", ") || "no source recorded"}`,
    meta: html`<span class="k-num">${relativeAge(one.lastSeen, data.now)}</span>`,
    action: fixForm(data.repo, one, data.selfHref),
  }));
  const shortHistory = list.complete ? "" : note(`Not enough recorded history: test results are kept for 180 days, so ${list.days} days can't be counted in full.`);
  const body = list.rows.length === 0
    ? (list.complete ? empty({ title: "No mixed outcomes recorded" }) : "")
    : joinHtml(rows);
  return screen("Flaky tests", joinHtml([
    phoneHeader("Flaky tests", { back: data.back }),
    doc(
      docHeader({ back: [data.back, data.name], title: "Flaky tests", meta: "Mixed outcomes under recorded conditions" }),
      shortHistory,
      body,
      disclose("What this covers", joinHtml([
        note(flakyCoverageWords(list)),
        list.notPaired === 0 ? "" : note(`${list.notPaired} GitHub re-run${list.notPaired === 1 ? "" : "s"} not paired.`),
        note("Not recorded: network, other processes, time of day."),
      ])),
    ),
  ], "\n"), { chrome });
}

/** One row's history. */
export function flakyRowPage(chrome: Chrome, data: { name: string; repo: string; back: string; row: FlakyRow; history: readonly FlakyObservation[]; now: Date }): Screen {
  const one = data.row;
  const history = data.history.length === 0 ? note("No history recorded.") : joinHtml(data.history.map(entry => row({
    chip: html``, title: KIND_WORDS[entry.kind],
    desc: `${entry.failed} failed · ${entry.passed} passed · ${entry.commit ?? "commit not recorded"} · ${entry.conditions}`,
    meta: html`<span class="k-num">${relativeAge(entry.at, data.now)}</span>`,
  })));
  return screen(one.name, joinHtml([
    phoneHeader("Flaky test", { back: data.back }),
    doc(
      docHeader({ back: [data.back, "Flaky tests"], title: one.name, meta: flakyStatusWords(one), right: fixForm(data.repo, one, data.back) }),
      facts([
        ["Seen", `${one.observations} time${one.observations === 1 ? "" : "s"}, last ${relativeAge(one.lastSeen, data.now)}`],
        ["Hard failures", String(one.hardFailures)],
        ["Conditions", one.conditions.join(", ") || "not recorded"],
        ["Recorded by", one.sources.join(", ") || "not recorded"],
        ["Test file last changed", one.fileChanged === null ? "not recorded" : relativeAge(one.fileChanged, data.now)],
      ]),
      html`<section class="k-sec" aria-labelledby="f-history"><h3 id="f-history">History</h3>${history}</section>`,
    ),
  ], "\n"), { chrome });
}
