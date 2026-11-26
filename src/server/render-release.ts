/**
 * The release approval sheet (docs/plans/trusted-release-reports.md, slice A, A7): one screen with what the person is
 * approving, GitHub CI now, what approving does, what changed and every term, then one Approve release button. The
 * page only shows: the approval POST (`/t/<id>/approve`, `sheet=release`) proves the person, the card and the scope
 * again (release-approval.ts approveReleaseCard).
 */
import { html, postForm, type Html } from "../html.js";
import type { ApprovalFacts } from "../design/kit.js";
import { ciWords, type ReleaseApprovalCard } from "../release-approval.js";
import { releaseAccessWords } from "../release-card.js";
import { checkAccessWords } from "../check-access.js";
import { projectName } from "../project.js";
import { screen, type Chrome, type Screen } from "./chrome.js";
import { approvalTerms, approveForm, chip, disclose, doc, docHeader, facts, field, infoLine, input, note, notice, slots, btn } from "./kit.js";
import { taskHref } from "./http.js";

export type ReleaseSheetData = {
  card: ReleaseApprovalCard;
  /** The single-use approval nonce for this person, task and card digest ("" when nothing can be approved here). */
  nonce: string;
  facts: ApprovalFacts;
  /** This computer's local owner: releases need a full sign-in first (scope.ts localApprovalEligible). */
  local: { message: string; action: string; href: string } | null;
  problem: string | null;
  /** An automatic release held after its merge (release-auto.ts): why, and that a person may let it go on. */
  held?: string | null;
};

/** The change list: open for short releases (<= 5 commits), folded for larger ones. */
function changesHtml(card: ReleaseApprovalCard): Html {
  const changes = card.card.changes;
  const id = card.seal.identity;
  if (changes.commits === null) {
    return note(changes.baselineUnreadable === true ? "What changed couldn't be read: the last verified release's commit can't be read."
      : `What changed couldn't be read${changes.why === undefined ? "" : ` (${changes.why})`}. See pull request #${id.pr} on GitHub.`);
  }
  const head = changes.baseline === null ? `Pull request #${id.pr}'s commits` : `Since the last verified release (${changes.baseline.slice(0, 7)})`;
  const list = changes.commits.length === 0 ? note("No commits.")
    : html`<ul class="k-list">${changes.commits.map(one => html`<li><code class="k-mono">${one.sha.slice(0, 7)}</code> ${one.subject}</li>`)}</ul>`;
  return disclose(`What changed: ${changes.commits.length} commit${changes.commits.length === 1 ? "" : "s"}`, html`<p class="k-note">${head}</p>${list}`, changes.commits.length > 0 && changes.commits.length <= 5);
}

/** Concise, human-readable summary of what approving this release does, with any unsandboxed access called out plainly. */
function releaseSummaryHtml(card: ReleaseApprovalCard): Html {
  const id = card.seal.identity;
  const carries = card.seal.kind === "terms" && card.seal.terms.policy.carry;
  const checkKind = card.seal.kind === "check" && card.seal.purpose.check === "deploy"
    ? "Deploy check (~4 min)"
    : checkAccessWords(id.access);
  const accessWarning = releaseAccessWords(id.access);
  const rows: ReadonlyArray<readonly [string, Html | string]> = [
    ["Commit", html`<code class="k-mono" title="${id.approvedSha}">${id.approvedSha.slice(0, 7)}</code> · <code class="k-mono">${id.branch}</code>`],
    ["Check", checkKind],
    ["On approve", `Runs the release check on ${id.approvedSha.slice(0, 7)}, then deploys, merges, tags and publishes once GitHub CI and the check pass.`],
    ["Later commits", carries ? "Later commits that only change tests, docs or the changelog carry this approval." : "Every later commit asks again."],
  ];
  return html`${accessWarning === null ? "" : notice(accessWarning)}${facts(rows)}`;
}

/** Every signed term, collapsed by default and grouped with release fields first so full audit detail stays one tap away. */
function termsHtml(card: ReleaseApprovalCard): Html {
  const isRelease = (key: string) => key.startsWith("release.") || key.startsWith("releaseCheck.");
  const releaseTerms = card.terms.filter(line => isRelease(line.key));
  const scopeTerms = card.terms.filter(line => !isRelease(line.key));
  const renderRows = (lines: ReleaseApprovalCard["terms"]) => facts(lines.map(line => [line.label, html`<span class="k-mono">${line.value}</span>`] as const));
  const inner = html`${releaseTerms.length === 0 ? "" : html`<h3>Release</h3>${renderRows(releaseTerms)}`}${scopeTerms.length === 0 ? "" : html`<h3>Underlying scope &amp; settings</h3>${renderRows(scopeTerms)}`}`;
  return disclose(`Every term (${card.terms.length})`, inner, false);
}

export function releaseSheetPage(chrome: Chrome, data: ReleaseSheetData): Screen {
  const card = data.card;
  const id = card.seal.identity;
  const title = `Release ${id.packageVersion}`;
  const summaryHtml = releaseSummaryHtml(card);
  const ci = ciWords(card.ci, id.approvedSha);
  const notRunning = card.stopped === null ? "" : infoLine(html`The release isn't running (it stopped at ${card.stopped.step}). After you approve, run <code class="k-mono">toolroll release ${id.branch}</code>.`);
  let status: Html, text: string, acts: Html | string, terms: string, wait = false;
  if (card.approved !== null) {
    status = html`${chip("Approved", "done")}<h2>Release approved</h2>`;
    text = `Approved by ${card.approved.by}. ${ci}`;
    acts = btn("Open the task", { variant: "outline", href: taskHref(card.taskId) });
    terms = "";
  } else if (card.refusal !== null) {
    status = html`${chip("Can't approve", "failed")}<h2>Can't approve this release now</h2>`;
    text = card.refusal;
    acts = btn("Open the task", { variant: "outline", href: taskHref(card.taskId) });
    terms = "";
  } else if (data.local !== null) {
    wait = true;
    status = html`${chip("Needs you", "needs")}<h2>Ready for your approval</h2>`;
    text = `${ci} Releases need a full sign-in on this computer.`;
    acts = btn(data.local.action, { variant: "primary", href: data.local.href });
    terms = data.local.message;
  } else {
    wait = true;
    status = html`${chip("Needs you", "needs")}<h2>Ready for your approval</h2>`;
    text = ci;
    acts = data.nonce === "" ? "" : approveForm({
      action: `${taskHref(card.taskId)}/approve`, kind: "standard", facts: data.facts, label: "Approve release", primary: true,
      form: { hidden: { nonce: data.nonce, digest: card.digest, sheet: "release" }, attrs: { class: "k-form", "data-release-approve": card.digest } },
    });
    terms = approvalTerms("standard", data.facts);
  }
  // Action card + concise summary up top so approving takes one screen; commits and full signed terms right below.
  const body = doc(
    docHeader({ title, back: [taskHref(card.taskId), "Task"], meta: `${projectName(id.repo)} · pull request #${id.pr}` }),
    // A refused approval says why first, above the card it now shows.
    data.problem === null ? "" : notice(data.problem),
    slots({ wait, attrs: { "data-release-sheet": card.taskId }, status, text, body: summaryHtml, acts, terms }),
    notRunning,
    data.held == null ? "" : html`<section class="k-sec" data-release-held><h3>Held after its merge</h3><p class="k-note">${data.held}.</p>${postForm(`${taskHref(card.taskId)}/release/go-on`,
      html`${field({ id: "go-on-password", label: "Your password", control: input({ id: "go-on-password", name: "password", type: "password", attrs: { required: true, autocomplete: "current-password" } }) })}${btn("Let it go on", { variant: "primary", type: "submit" })}`, { attrs: { class: "k-form" } })}</section>`,
    changesHtml(card),
    termsHtml(card),
  );
  return screen(title, body, { chrome });
}
