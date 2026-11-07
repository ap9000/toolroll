/** The task page's follow-through sections (docs/plans/fleet-follow-through.md): findings, failed checks, before and after,
 * and the handover note. All of a finding's text is model output or repository text: it renders as text, in `html`'s
 * escaping, and no action here is reachable from it. Every form posts to the one action in tasks.ts. */
import { checkRepairsOfTask, checkRepairWords } from "../check-repair.js";
import { evidencePairsOf, evidenceWords, failingFirstOf, failingFirstWords } from "../evidence-pair.js";
import { findingLine, findingsOfTask, findingSourceWords, findingStandingWords, type Finding } from "../findings.js";
import { handoverLines, handoverNoteOf } from "../handover-note.js";
import { html, joinHtml, postForm, type Html } from "../html.js";
import { providerCaptures, type ProviderCapture } from "../provider-capture.js";
import type { Store } from "../store.js";
import { btn, disclose, field, input, note, textarea } from "./kit.js";

export type FollowThroughView = { findings: Html | ""; findingCount: number; openFindings: number; repairs: Html | ""; evidence: Html | ""; handover: Html | "" };

const act = (taskHref: string, name: string, label: string, hidden: Readonly<Record<string, string | number>> = {}, variant: "primary" | "outline" = "outline"): Html =>
  postForm(`${taskHref}/follow-through`, joinHtml([
    html`<input type="hidden" name="act" value="${name}">`,
    ...Object.entries(hidden).map(([key, value]) => html`<input type="hidden" name="${key}" value="${String(value)}">`),
    btn(label, { variant, type: "submit" }),
  ]));

function findingRow(one: Finding, taskHref: string, canAct: boolean): Html {
  const answered = one.state === "accepted" || one.state === "rejected";
  const closing = canAct && one.state !== "closed" ? disclose("Close it", postForm(`${taskHref}/follow-through`, joinHtml([
    html`<input type="hidden" name="act" value="close"><input type="hidden" name="finding" value="${String(one.id)}">`,
    field({ id: `finding-close-${one.id}`, label: "Why it can close", control: input({ id: `finding-close-${one.id}`, name: "note" }) }),
    btn("Close finding", { variant: "outline", type: "submit" }),
  ]))) : "";
  return html`<li data-finding="${one.state}"><p>${findingLine(one)}</p><p class="meta">${findingStandingWords(one)}</p><p class="meta">From ${findingSourceWords(one.source)}. Requested: ${one.action}</p>${
    canAct && answered ? act(taskHref, "resend", "Send it back", { finding: one.id }) : ""}${closing}</li>`;
}

function sendForm(taskHref: string): Html {
  return disclose("Send a finding", postForm(`${taskHref}/follow-through`, joinHtml([
    html`<input type="hidden" name="act" value="send">`,
    field({ id: "finding-note", label: "What's wrong", control: textarea({ id: "finding-note", name: "note", rows: 3 }) }),
    field({ id: "finding-file", label: "File, if there is one", control: input({ id: "finding-file", name: "file" }) }),
    field({ id: "finding-line", label: "Line", control: input({ id: "finding-line", name: "line", type: "number" }) }),
    btn("Send to the agent", { variant: "outline", type: "submit" }),
  ])));
}

const captureRow = (one: ProviderCapture, taskHref: string, canAct: boolean): Html => html`<li><p class="meta">${one.provider}, build #${one.run}${one.label === null ? "" : `, marked ${one.label}`}</p><p class="mono">${one.text.slice(0, 500)}</p>${
  canAct && one.label === null ? joinHtml([act(taskHref, "mark", "Used-up plan", { capture: one.id, label: "exhausted" }), act(taskHref, "mark", "Something else", { capture: one.id, label: "not-exhausted" })]) : ""}</li>`;

export function followThroughView(store: Store, root: string, taskId: string, taskHref: string, canAct: boolean, now: Date): FollowThroughView {
  const findings = findingsOfTask(store, taskId);
  const open = findings.filter(one => one.state === "open" || one.state === "with-person").length;
  const repairs = checkRepairsOfTask(store, taskId).filter(one => one.state !== "closed");
  const pairs = evidencePairsOf(store, root, taskId, now);
  const step = failingFirstOf(store, taskId);
  const stepWords = failingFirstWords(step);
  const hasRun = store.lookupRef(taskId) !== null && store.runsFor(store.lookupRef(taskId)!.id).some(one => one.role === "builder" && one.finishedAt !== null);
  const family = store.taskFamilyOf(taskId, null, true);
  const familyRuns = new Set((family?.versions.map(one => one.id) ?? [taskId]).flatMap(id => { const ref = store.lookupRef(id); return ref === null ? [] : store.runsFor(ref.id).map(run => run.id); }));
  const captures = providerCaptures(store, null, 200).filter(one => familyRuns.has(one.run)).slice(0, 5);
  const latestFailed = repairs.find(one => one.state !== "fixed");
  const note1 = handoverNoteOf(store, root, taskId, now);
  return {
    findingCount: findings.length, openFindings: open,
    findings: findings.length === 0 && !canAct ? "" : joinHtml([
      findings.length === 0 ? "" : html`<ul class="result-changes">${findings.map(one => findingRow(one, taskHref, canAct))}</ul>`,
      canAct ? sendForm(taskHref) : "",
    ]),
    repairs: repairs.length === 0 ? "" : html`<ul class="result-changes">${repairs.map(one => html`<li data-check-repair="${one.state}"><p>${checkRepairWords(one)}</p>${
      one.repairTask === null ? "" : html`<p class="meta"><a class="k-link" href="/t/${encodeURIComponent(one.repairTask)}">Open the repair</a></p>`}${
      canAct && one.repairTask === null && (one.state === "waiting" || one.state === "parked") ? act(taskHref, "repair", "Start a repair", { run: one.sourceRun }, "primary") : ""}</li>`)}</ul>`,
    evidence: pairs.length === 0 && stepWords === null && captures.length === 0 && !(canAct && hasRun) ? "" : joinHtml([
      pairs.length === 0 ? "" : html`<ul class="result-changes">${pairs.map(one => html`<li data-evidence="${one.reading}"><p>${evidenceWords(one)}</p><p class="meta"><a class="k-link" href="/r/${String(one.before.run)}">Before</a>${
        one.after === null ? "" : html` · <a class="k-link" href="/r/${String(one.after.run)}">After</a>`}${one.before.screenshots.length + (one.after?.screenshots.length ?? 0) === 0 ? "" : ` · ${one.before.screenshots.length + (one.after?.screenshots.length ?? 0)} screenshots`}</p></li>`)}</ul>`,
      stepWords === null ? "" : note(stepWords),
      step?.output == null ? "" : html`<p class="mono">${step.output}</p>`,
      canAct && hasRun ? html`<div class="k-acts">${joinHtml([
        ...(latestFailed === undefined ? [] : [act(taskHref, "save-evidence", "Save the failing result", { run: latestFailed.sourceRun })]),
        ...(pairs.length === 0 ? [] : [act(taskHref, "rerun-evidence", "Run the same check again")]),
      ])}</div>` : "",
      canAct ? act(taskHref, step === null ? "failing-first-on" : "failing-first-off", step === null ? "Ask for a failing test first" : "Turn off failing test first") : "",
      captures.length === 0 ? "" : disclose("What the provider said", html`<ul class="result-changes">${captures.map(one => captureRow(one, taskHref, canAct))}</ul>`),
    ]),
    handover: note1 === null ? "" : html`<pre class="mono handover-note">${handoverLines(note1).join("\n")}</pre>`,
  };
}
