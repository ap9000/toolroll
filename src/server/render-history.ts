/**
 * History pages on the revamp kit (UI revamp wave B): one attempt (/r/<id>), a task's full record (/t/<id>/evidence),
 * an agent's question (/d/<id>). Reading pages: the phone header, then one `doc` column. Rules: src/design/KIT.md.
 */
import type { EvidencePack } from "../evidence-pack.js";
import { closedQuestionReason, LIMITS } from "../decision.js";
import { type Html, type HtmlValue, html, joinHtml, postForm } from "../html.js";
import type { RouteStamp } from "../phase-routing.js";
import { projectName } from "../project.js";
import { RESULT_REVIEW_SCRIPT, type ResultTab } from "../result-review.js";
import type { StructuredHandoffView, TerminalDiffView } from "../result-evidence-readers.js";
import type { Artifact, Decision, DiffComment, Publication, Run } from "../store.js";
import type { ReviewFacts } from "../workspace-ui.js";
import { type Chrome, isOverdue, screen, type Screen, sentenceCase, whenTime } from "./chrome.js";
import { taskHref } from "./http.js";
import { btn, chip, disclose, doc, docHeader, dock, facts, note, notice, phoneHeader, radios, slots, status } from "./kit.js";
import {
  editorFileHref, evidenceBundleCard, evidenceWords, humanBytes, prefillScript, type ProofBundleView, type ResultDetail,
  resultPanelHtml, revisionSealFields, runFactsRows, runNoun, terminalDiffCard,
} from "./render-results.js";
import { publicationFactsOf } from "./render-tasks.js";

/** A section of a reading page: its heading and body (kit `k-sec`). */
export const sec = (title: string, body: HtmlValue, attrs: Html = html``): Html => html`<section class="k-sec"${attrs}><h3>${title}</h3>${body}</section>`;

/** The root every kit server page carries, so the workspace frames it as a kit page (no padding, panel or desk header). */
const kitPage = (attrs: Html, ...parts: HtmlValue[]): Html => html`<div class="h-page" data-kit-page${attrs}>${parts}</div>`;

// ---- /r/<id>: one attempt ----------------------------------------------------------------------------------------

export function runPage(
  chrome: Chrome,
  run: Run,
  taskId: string,
  artifacts: Artifact[],
  terminal: TerminalDiffView | null = null,
  notes: { id: number; author: string; note: string; createdAt: string }[] = [],
  csrf = "",
  comments: DiffComment[] = [],
  ciRepair: { pr: number } | null = null,
  liveScript?: string,
  peekable = false,
  running = false,
  editor: { worktree: string } | null = null,
  editorToggle: { on: boolean } | null = null,
  noted = false,
  structuredHandoff: StructuredHandoffView | null = null,
  proofBundle: ProofBundleView | null = null,
  route: RouteStamp | null = null,
  publicationRow: Publication | null = null,
  review: ReviewFacts | null = null,
  result: { detail: ResultDetail; tab: ResultTab; user: string; requestToken: string } | null = null,
  sourceDigest: string | null = null,
): Screen {
  const title = `${sentenceCase(runNoun(run))} #${run.id}`;
  // The facts region: a live run's is what the poller swaps; a finished run's stands still.
  const summary = sec("Summary", html`<div id="run-facts">${runFactsRows(run, taskId, running, route)}</div>${running ? html`<p class="k-note" id="run-facts-stamp"></p>` : ""}`);
  // The live transcript (arc 1): the agent's own words, streamed to a file beside the run and polled as raw text.
  // Honesty stated on the surface: display only, and the machine running the agent could alter it.
  const transcript = !running ? "" : sec("What the agent is saying", !peekable
    ? note(html`The live transcript is off. Start serve with <span class="k-mono">--runner &lt;name&gt;</span> naming this machine's worker, and it appears here.`)
    : run.provider !== "claude"
      ? note(`The live transcript needs the claude harness for now; this build runs on ${run.provider}.`)
      : html`${note("Display only: this is not evidence, and the machine running the agent could alter it.")}<pre id="live-transcript" class="k-mono h-pre h-live"></pre><p class="k-note" id="live-transcript-state"></p>`);
  // The live peek region (A2): the poller fills it only on a serve that asserted its runner; otherwise the section
  // says why it is empty, so the click never lands on silence.
  const peek = !running ? "" : sec("What is changing right now", peekable
    ? html`<div id="run-peek">${note("Watching… the first look lands within 15 seconds.")}</div><p class="k-note" id="run-peek-stamp"></p>`
    : note(html`The live file view is off. Start serve with <span class="k-mono">--runner &lt;name&gt;</span> naming this machine's worker, and it appears here.`));

  const resultSummary = structuredHandoff?.conclusion ?? run.handoff;
  const list = (label: string, items: readonly string[]): Html | string => items.length === 0 ? "" : html`<div class="h-list"><p class="k-note">${label}</p><ul>${items.map(one => html`<li>${one}</li>`)}</ul></div>`;
  const handoff = resultSummary === null ? "" : sec("Result", html`<p class="h-read">${resultSummary}</p>${structuredHandoff === null ? "" : [
    list("Completed", structuredHandoff.changes), list("Checks the agent reported", structuredHandoff.verification), list("Follow-up", structuredHandoff.followUps)]}`);

  // Review comments on the immutable terminal diff (M6.8): listed, added, and sealed into ONE unapproved revision task.
  // The seal only creates the unapproved task; its approval screen restates the batch.
  const hasTerminalDiff = terminal !== null && terminal.patch !== null && !("problem" in (terminal.patch as object));
  const commentPath = (path: string, line: number | null): Html => {
    const shown = `${path}${line === null ? "" : `:${line}`}`;
    const href = editor === null ? null : editorFileHref(editor.worktree, path, line);
    return href === null ? html`<span class="k-mono">${shown}</span> ` : html`<a class="k-mono k-link" href="${href}">${shown}</a> `;
  };
  const commentRows = comments.map(one => html`<li class="diff-comment"><span class="k-num k-muted">${whenTime(one.createdAt)}</span><span><b>${one.author}</b> ${one.path === null ? "" : commentPath(one.path, one.line)}${one.note}</span></li>`);
  const commentForm = csrf === "" || !hasTerminalDiff ? null : postForm(`/r/${run.id}/comment`, html`<div class="h-pair">\
<div class="k-field"><label class="k-label" for="comment-path">File</label><input class="k-input k-mono" id="comment-path" type="text" name="path" placeholder="Choose a line above"></div>\
<div class="k-field"><label class="k-label" for="comment-line">Line</label><input class="k-input" id="comment-line" type="text" name="line" placeholder="—" inputmode="numeric"></div></div>\
<div class="k-field"><label class="k-label" for="comment-note">Change requested</label><textarea class="k-textarea" id="comment-note" name="note" rows="2" maxlength="${LIMITS.note}" placeholder="What should change, and why" aria-describedby="comment-note-limit"${noted ? html` autofocus` : ""}></textarea>\
<p class="k-hint" id="comment-note-limit">Up to ${LIMITS.note} characters</p></div><div class="k-acts">${btn("Add annotation", { sm: true, type: "submit", attrs: { "data-k-busy": "Adding…" } })}</div>`,
  { attrs: { class: "h-form", id: "comment-form" } });
  // The device-side half of the editor-link activation (arc 6, finding 1): only when the capability exists and this
  // run belongs to this machine's runner; the person at the browser flips it.
  const editorToggleForm = editorToggle === null || csrf === "" ? "" : postForm("/session/editor-links",
    html`${btn(editorToggle.on ? "Stop opening files in VS Code here" : "Open files in VS Code from this device", { variant: "ghost", sm: true, type: "submit" })}<p class="k-note">Only useful when this browser runs on the machine that holds the worktrees.</p>`,
    { attrs: { class: "h-inline" }, returnTo: `/r/${run.id}`, hidden: { on: editorToggle.on ? "0" : "1" } });
  const reviseForm = csrf === "" || comments.length === 0 ? "" : postForm(`/r/${run.id}/revise`, html`${revisionSealFields(comments, sourceDigest)}${slots({
    status: html`<h2>${comments.length} ${comments.length === 1 ? "annotation" : "annotations"} ready</h2>`,
    text: "Creates one revision carrying this exact batch. You review its scope before anything builds.",
    acts: btn("Create revision from annotations", { variant: "primary", type: "submit", attrs: { "data-k-busy": "Creating…" } }),
    terms: "Nothing builds until its scope is approved.",
  })}`, { attrs: { class: "revision-from-comments" } });
  // CI repair, suggestion-first (M8.18): the observed red episode earns a button; the button drafts ONE unapproved
  // task; a person approves it.
  const repair = ciRepair === null || csrf === "" ? "" : sec(`Checks are failing on pull request #${ciRepair.pr}`, html`${note("Seen by the pull request watcher. Drafting a repair makes one unapproved task; you approve its scope before anything builds.")}${
    postForm(`/r/${run.id}/draft-repair`, btn("Draft a repair task", { sm: true, type: "submit", attrs: { "data-k-busy": "Drafting…" } }), { attrs: { class: "h-inline" } })}`);
  const reviewSec = commentRows.length === 0 && commentForm === null ? "" : sec("Review and revise", html`${note("Annotate the diff above. When the batch is ready, create one scoped revision task from it.")}${
    commentRows.length === 0 ? "" : html`<ul class="h-notes diff-comments">${commentRows}</ul>`}${commentForm ?? ""}${reviseForm}${editorToggleForm}`);

  const saved = artifacts.length === 0 ? "" : sec("Saved files", html`<ul class="h-files">${artifacts.map(artifact => html`<li><a class="k-link" href="/r/${run.id}/evidence/${artifact.id}">${evidenceWords(artifact.kind)}</a>\
<span class="k-num k-muted" title="${artifact.bytesStored} bytes stored${artifact.truncated ? ` of ${artifact.bytesOriginal}` : ""}">${artifact.truncated ? `${humanBytes(artifact.bytesStored)} of ${humanBytes(artifact.bytesOriginal)} · partial` : humanBytes(artifact.bytesStored)}</span></li>`)}</ul>`);

  const noteRows = notes.map(one => html`<li><span class="k-num k-muted">${whenTime(one.createdAt)}</span><span><b>${one.author}</b> ${one.note}</span></li>`);
  const noteForm = csrf === "" ? "" : postForm(`/r/${run.id}/note`, html`<label class="k-sr" for="run-note">Add a note</label><input class="k-input" id="run-note" type="text" name="note" placeholder="A note for whoever reads this attempt next" autocomplete="off">${btn("Add note", { sm: true, type: "submit", attrs: { "data-k-busy": "Adding…" } })}`, { attrs: { class: "h-addnote" } });
  const notesSec = notes.length === 0 && noteForm === "" ? "" : sec("Notes", html`${noteRows.length === 0 ? note("No notes yet. A note stays with this attempt for whoever reads it next.") : html`<ul class="h-notes">${noteRows}</ul>`}${noteForm}`);

  // A finished result (package 3) is the ONE shared panel (Summary / Changes / Checks, Request changes beside it), the
  // same markup the review cockpit and the chat's result view render. Every other run keeps its record by record page.
  const resultPanel = result === null ? null : resultPanelHtml(result.detail, {
    place: "run", tab: result.tab, csrf, user: result.user, noted, requestToken: result.requestToken,
    hrefFor: one => (one === "summary" ? `/r/${run.id}` : `/r/${run.id}?tab=${one}`), returnTo: `/r/${run.id}?record=1`, back: null,
  });
  const body = kitPage(html``,
    phoneHeader(title, { back: taskHref(taskId) }),
    doc(
      docHeader({ title, back: [taskHref(taskId), "Task"], meta: html`Task <a class="k-mono k-link" href="${taskHref(taskId)}">${taskId}</a>${run.startedAt === null ? "" : html` · started ${whenTime(run.startedAt)}`}` }),
      summary,
      transcript,
      peek,
      ...(resultPanel === null
        ? [handoff, evidenceBundleCard(proofBundle, run, publicationFactsOf(publicationRow), review), terminal === null ? "" : terminalDiffCard(terminal, run.id, editor, commentForm !== null), reviewSec, repair]
        : [html`<div class="h-panel">${resultPanel}</div>`, editorToggleForm]),
      saved,
      notesSec,
    ),
  );
  return screen(title, body, {
    chrome,
    // One composed functional script (arc 4 contract): the pollers when the run is live, the result panel's script or
    // the comment prefill when a form exists. Neither fetches beyond the pollers.
    ...(liveScript === undefined && commentForm === null && resultPanel === null
      ? {}
      : { functional: { script: (liveScript ?? "") + (resultPanel !== null ? RESULT_REVIEW_SCRIPT : commentForm === null ? "" : prefillScript()), fetches: liveScript !== undefined } }),
  });
}

// ---- /d/<id>: an agent's question ---------------------------------------------------------------------------------

export type QuestionPlace = { title: string | null; repo: string | null; run: Pick<Run, "id" | "role"> | null };

/**
 * The question an agent asked, on top: what it asked and why, the options as radio cards with its recommendation
 * marked, an optional note, and one Answer (kind none: one click). An irreversible option asks for a tick first; the
 * answer route checks it again. A refusal shows in the box with nothing changed; an answer replaces the box.
 */
export function decisionPage(
  chrome: Chrome,
  decision: Decision,
  taskId: string,
  artifacts: Artifact[],
  now: Date,
  place: QuestionPlace,
  returnTo: string | null = null,
  refusal: string | null = null,
  /** What a refused answer carried: the choice and the note stay in the box. */
  draft: { choice: string | null; note: string | null } | null = null,
): Screen {
  const back: [string, string] = returnTo === null ? ["/", "Home"] : [returnTo, "Back to the chat"];
  const runWords = place.run === null ? null : `${runNoun(place.run)} #${place.run.id}`;
  const project = place.repo === null ? null : projectName(place.repo);
  const meta = html`${project === null ? "" : html`${project} · `}<span class="k-mono">${taskId}</span>${runWords === null ? "" : ` · ${runWords}`} asked ${whenTime(decision.createdAt)}${
    decision.deadline === null || decision.state !== "open" ? "" : html` · answer by ${whenTime(decision.deadline)}`}`;
  const open = decision.state !== "answered";
  const irreversible = decision.options.filter(option => !option.reversible);
  let box: Html;
  if (decision.supersededReason !== null) {
    box = slots({ status: html`${chip("Closed")}<h2>${decision.question}</h2>`, text: closedQuestionReason(decision.supersededReason), acts: btn("Open task", { href: taskHref(taskId) }), terms: "Nothing waits on this question now." });
  } else if (!open) {
    const chosen = decision.options.find(option => option.id === decision.choice);
    box = slots({
      status: html`${chip("Answered", "done")}<h2>${decision.question}</h2>`,
      text: html`${chosen?.label ?? decision.choice ?? ""} · by ${decision.answeredBy ?? "someone"}${decision.answeredAt === null ? "" : html` at ${whenTime(decision.answeredAt)}`}${decision.note === null ? "" : ` · “${decision.note}”`}`,
      acts: btn("Open task", { href: taskHref(taskId) }),
      terms: chosen === undefined ? "" : chosen.consequence,
    });
  } else {
    const options = radios({
      name: "choice", legend: "Choose one",
      current: draft?.choice !== null && draft?.choice !== undefined && decision.options.some(option => option.id === draft.choice) ? draft.choice : decision.recommendation,
      items: decision.options.map(option => ({
        value: option.id, label: option.label, text: option.consequence,
        tag: html`${option.id === decision.recommendation ? chip("Recommended", "", { dot: false }) : ""}${option.reversible ? "" : chip("Can't be undone", "failed", { dot: false })}`,
      })),
    });
    const noteField = html`<div class="k-field"><label class="k-label" for="answer-note">Note for the agent <span class="k-muted">(optional)</span></label><textarea class="k-textarea" id="answer-note" name="note" rows="2" maxlength="${LIMITS.note}" placeholder="Anything it should know with your answer">${draft?.note ?? ""}</textarea></div>`;
    const confirm = irreversible.length === 0 ? "" : html`<label class="h-check"><input type="checkbox" name="confirm" value="yes"><span>I understand ${irreversible.length === 1 ? `“${irreversible[0]!.label}” can't be undone` : "the options marked so can't be undone"}.</span></label>`;
    const overdue = isOverdue(decision, now);
    box = postForm(`/d/${decision.id}/answer`, slots({
      wait: true,
      status: html`${status("needs")}<h2>${decision.question}</h2>`,
      text: decision.recap,
      body: html`${options}${noteField}${confirm}`,
      acts: btn("Answer", { variant: "primary", type: "submit", docked: true, attrs: { "data-k-busy": "Answering…" } }),
      terms: html`Answering needs no password.${overdue ? " The answer was due; the build still waits for it." : ""}`,
      err: refusal === null ? undefined : `${sentenceCase(refusal)}. Nothing changed.`,
    }), { attrs: { class: "h-question", id: "answer-form" }, returnTo });
  }
  const looked = artifacts.length === 0 ? "" : sec("What the agent looked at", html`<ul class="h-files">${artifacts.map(artifact => html`<li><a class="k-link" href="/d/${decision.id}/evidence/${artifact.id}">${evidenceWords(artifact.kind)}</a><span class="k-num k-muted">${humanBytes(artifact.bytesStored)}${artifact.truncated ? " · partial" : ""}</span></li>`)}</ul>`);
  const stopped = !open || place.run === null ? "" : sec("Where it stopped", html`<p class="h-read k-muted">${sentenceCase(runWords ?? "")} asked this and holds its work until you answer. <a class="k-link" href="/r/${place.run.id}?record=1">See the attempt</a></p>`);
  const answering = open && decision.supersededReason === null;
  const body = kitPage(html``,
    phoneHeader(project ?? "Question", { back: back[0] }),
    // The shell's phone header already says this page's title (the screen title), so the h1 is drawn once.
    doc(docHeader({ title: place.title ?? taskId, back, meta, same: true }), box, looked, stopped),
    // On a phone the one primary lives in the dock; it submits the same form.
    answering ? dock(btn("Answer", { variant: "primary", type: "submit", attrs: { form: "answer-form", "data-k-busy": "Answering…" } })) : "",
  );
  return screen(place.title ?? `Question · ${taskId}`, body, { chrome });
}

// ---- /t/<id>/evidence: the full record ----------------------------------------------------------------------------

const at = (iso: string | null): Html | string => iso === null ? "—" : whenTime(iso);
const shortHash = (hash: string | null): Html | string => hash === null ? "—" : html`<span class="k-mono" title="${hash}">${hash.slice(0, 12)}</span>`;
const usd = (value: number | null): string => value === null ? "—" : `$${value.toFixed(value < 1 && value > 0 ? 4 : 2)}`;
const webLink = (url: string): Html => /^https:\/\/[^\s"'<>]+$/.test(url) ? html`<a class="k-link" href="${url}">${url}</a>` : html`${url}`;
const filerWords = (who: EvidencePack["versions"][number]["filedBy"]): string => who === null || who.name === null ? "automation" : who.kind === "person" ? who.name : `${who.name} (${who.kind})`;
const basisWords: Record<NonNullable<NonNullable<EvidencePack["versions"][number]["scope"]>["approved"]>["basis"], string> = {
  person: "", mode: " (operating mode)", flow: " (the flow runs on its own)", lead: " (the lead, not a person)", schedule: " (standing order)",
  carried: " (carried from their release approval)", unknown: " (no person's proof on record)",
};
function stateChip(state: string): Html {
  return state === "done" ? status("finished") : state === "failed" ? status("failed") : state === "running" ? status("running")
    : state === "queued" ? status("queued") : chip(sentenceCase(state));
}

/** A task's full record, read-only: what was asked and approved, every agent that ran, the result, and its sealed audit
 * log entries, with the JSON download and Print. The same facts as the pack's JSON (evidence-pack.ts). */
export function evidenceRecordPage(chrome: Chrome, pack: EvidencePack): Screen {
  const task = pack.task;
  const href = `/t/${encodeURIComponent(task.id)}`;
  const chain = pack.ledger.chain;
  const chainWords = chain.ok
    ? html`<span data-evidence-chain="ok">Chain verified · ${chain.entries} entries · head ${shortHash(chain.head)}${pack.ledger.checkpoint === null ? "" : ` · last checkpoint at entry #${pack.ledger.checkpoint.through}`}</span>`
    : html`<span data-evidence-chain="broken">Chain broken: ${chain.problem ?? "it doesn't verify"}</span>`;
  const rules = pack.rules === null ? "None: every plan asks a person" : html`${sentenceCase(pack.rules.now)}${pack.rules.changes.length === 0 ? "" : disclose(`${pack.rules.changes.length} ${pack.rules.changes.length === 1 ? "change" : "changes"}`,
    html`<ul class="h-notes">${pack.rules.changes.slice(-5).map(one => html`<li><span class="k-num k-muted">${at(one.at)}</span><span>${one.by}: ${one.change ?? ""}</span></li>`)}</ul>`)}`;
  const summary = sec("Summary", facts([
    ["Task", html`<span class="k-mono">${task.id}</span>${task.project === null ? "" : ` · ${task.project}`}`],
    ["Status", stateChip(task.state)],
    ["Approval rules", rules],
    ["Agents", pack.totals.runs === 0 ? "None ran" : `${pack.totals.runs} ${pack.totals.runs === 1 ? "run" : "runs"} · ${usd(pack.totals.costUsd)}`],
    ["Prepared", html`${at(pack.generatedAt)} for ${pack.generatedBy}`],
    ["Audit log", chainWords],
  ]));
  const broken = chain.ok ? "" : notice(html`The audit log's chain doesn't verify: ${chain.problem ?? "an entry changed"}. The record below is what the log holds now.`);

  const versions = pack.versions.map((version, index) => {
    const scope = version.scope;
    const approved = scope?.approved ?? null;
    const approvals = scope === null ? [] : scope.approvals.filter(one => one.digest === (approved?.digest ?? scope.digest));
    const rows: [string, HtmlValue][] = [["Filed", html`${at(version.filedAt)} by ${filerWords(version.filedBy)}`]];
    if (scope === null) rows.push(["Plan", "None written"]);
    else {
      rows.push(["Goal", scope.goal]);
      if (scope.outOfScope) rows.push(["Not in scope", scope.outOfScope]);
      if (scope.touches.length) rows.push(["Touches", joinHtml(scope.touches.map(one => html`<span class="k-mono">${one}</span>`), ", ")]);
      if (scope.acceptance.length) rows.push(["Requirements", html`<ol class="h-ol">${scope.acceptance.map(one => html`<li>${one.statement}</li>`)}</ol>`]);
      if (scope.budgetUsd !== null) rows.push(["Budget", usd(scope.budgetUsd)]);
      if (scope.writtenBy.length) rows.push(["Plan written by", [...new Set(scope.writtenBy.map(one => one.author))].join(", ")]);
      rows.push(["Approved", approved === null ? "Not approved" : html`${approved.by}${basisWords[approved.basis]} · ${at(approved.at)}${approved.current ? "" : " · the plan changed after this"}`]);
      if (approvals.length > 1) rows.push(["Approvals", joinHtml(approvals.map(one => html`${one.approver} · ${at(one.at)}`), html`<br>`)]);
      rows.push(["Plan version", shortHash(scope.digest)]);
    }
    const heading = pack.versions.length === 1 ? "Request and approval" : index === 0 ? "Request and approval" : `Revision ${index}`;
    return sec(heading, html`${pack.versions.length === 1 ? "" : html`<p class="k-note k-mono">${version.id}</p>`}${facts(rows)}`, html` data-evidence-version="${version.id}"`);
  });

  const runs = pack.versions.flatMap(version => version.runs);
  const agents = sec("Agents", runs.length === 0 ? note("No agent has run for this task yet.") : html`<div class="h-table" role="table" aria-label="Agents">\
<div class="h-tr h-th" role="row"><span role="columnheader">Run</span><span role="columnheader">Role</span><span role="columnheader">Agent</span><span role="columnheader">Outcome</span><span role="columnheader">Spend</span><span role="columnheader">Finished</span><span role="columnheader">Commit</span></div>\
${runs.map(run => html`<div class="h-tr" role="row"><span role="cell"><a class="k-mono k-link" href="/r/${run.id}?record=1">#${run.id}</a></span><span role="cell">${run.role}</span>\
<span role="cell">${run.agent}${run.model ? html` <span class="k-mono">${run.model}</span>` : ""}</span><span role="cell">${run.outcome === null ? "Running" : sentenceCase(run.outcome)}</span>\
<span role="cell" class="k-num">${usd(run.costUsd)}</span><span role="cell">${at(run.finishedAt)}</span><span role="cell">${shortHash(run.head)}</span></div>`)}</div>${
    runs.some(run => run.role === "builder" || run.role === "repair") ? disclose("Changed files", html`<div class="h-changes">${runs.filter(run => run.role === "builder" || run.role === "repair").map(run =>
      html`<p class="k-note">Run #${run.id}${run.diff === null ? "" : html` · diff ${shortHash(run.diff.sha256)}${run.diff.complete ? "" : " (partial)"}`}</p>${
      run.changedFiles === null ? note("Its changed files couldn't be read.") : run.changedFiles.length === 0 ? note("No files changed.") : html`<ul class="h-files">${run.changedFiles.map(file => html`<li><span class="k-mono">${file}</span></li>`)}</ul>`}`)}</div>`) : ""}`);

  const result = pack.result;
  const outcome = sec("Result", result === null ? note("No result yet.") : facts([
    ["Checks", html`${result.checks.detail}${result.checks.command ? html` <span class="k-mono">${result.checks.command}</span>` : ""}`],
    ["Completed", result.completedBy === null ? "Not yet" : html`${result.completedBy} · ${at(result.completedAt)}`],
    ["Published", result.publication === null ? "Not published" : html`${sentenceCase(result.publication.state)}${result.publication.prUrl ? html` · ${webLink(result.publication.prUrl)}` : ""}${result.publication.remoteState ? ` · ${result.publication.remoteState.toLowerCase()}` : ""}`],
    ["Commit", html`${shortHash(result.base)} → ${shortHash(result.head)}`],
    ...(result.caveats.length ? [["Caveats", joinHtml(result.caveats, html`<br>`)] as [string, HtmlValue]] : []),
  ]), html` data-evidence-result`);

  const entries = pack.ledger.entries.filter(one => one.source !== "request");
  const requests = pack.ledger.entries.length - entries.length;
  const log = sec("Audit log", html`${entries.length === 0 ? note("No entries.") : html`<ul class="h-log">${[...entries].reverse().map(one => html`<li data-ledger-id="${one.id}">\
<span class="k-num k-muted">${at(one.at)}</span><span><b>${one.actor}</b> ${one.action}${one.detail ? html`<span class="k-muted"> · ${one.detail}</span>` : ""}</span>\
<span class="k-muted">${one.outcome}</span><span class="h-seal">${shortHash(one.seal?.hash ?? null)}</span></li>`)}</ul>`}${
    requests > 0 ? note(`Plus ${requests} ${requests === 1 ? "request" : "requests"} made through the console (accepted or refused), listed in the JSON.`) : ""}${
    pack.ledger.truncated ? note(`This record holds ${entries.length} of the task's entries and the newest ${requests} requests; the audit log export has the rest.`) : ""}`);

  const json = `${href}/evidence?format=json`;
  const tools = html`<span class="k-acts h-tools">${btn("Download JSON", { sm: true, href: json, attrs: { download: true } })}${btn("Print", { sm: true, variant: "ghost", attrs: { "data-k-print": true } })}</span>`;
  const body = kitPage(html` data-evidence-pack="${task.id}"`,
    phoneHeader("Full record", { back: href }),
    doc(
      docHeader({ title: "Full record", back: [href, "Task"], meta: html`${task.title}${task.project === null ? "" : ` · ${task.project}`} · <span class="k-mono">${task.id}</span>`, right: tools }),
      html`<p class="k-note h-lead">Read-only. Everything below is sealed in the audit log; nothing here can be changed.</p>`,
      broken,
      summary,
      versions,
      agents,
      outcome,
      log,
      html`<p class="k-note h-foot">Record digest <span class="k-mono">${pack.digest}</span>. Each entry's seal can be rechecked from the JSON: <span class="k-mono">${pack.ledger.recipe}</span>.</p>`,
      html`<div class="h-phone-tools">${btn("Download JSON", { href: json, attrs: { download: true } })}</div>`,
    ),
  );
  return screen(`Full record · ${task.title}`, body, { chrome });
}
