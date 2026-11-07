/**
 * The release approval sheet (docs/plans/trusted-release-reports.md, slice A, A7): one screen with what the person is
 * approving, GitHub CI now, what approving does, what changed and every term, then one Approve release button. The
 * page only shows: the approval POST (`/t/<id>/approve`, `sheet=release`) proves the person, the card and the scope
 * again (release-approval.ts approveReleaseCard).
 */
import { html, joinHtml, postForm, type Html } from "../html.js";
import type { ApprovalFacts } from "../design/kit.js";
import { ciWords, releaseConsequence, type ReleaseApprovalCard } from "../release-approval.js";
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

/** The change list, folded: every commit when it is whole, or why it isn't. */
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
  return disclose(`What changed: ${changes.commits.length} commit${changes.commits.length === 1 ? "" : "s"}`, html`<p class="k-note">${head}</p>${list}`);
}

/** Every signed term, before the button. */
function termsHtml(card: ReleaseApprovalCard): Html {
  return disclose("Every term", facts(card.terms.map(line => [line.label, html`<span class="k-mono">${line.value}</span>`] as const)), true);
}

export function releaseSheetPage(chrome: Chrome, data: ReleaseSheetData): Screen {
  const card = data.card;
  const id = card.seal.identity;
  const title = `Release ${id.packageVersion}`;
  const summary = facts([
    ["Pull request", `#${id.pr}`],
    ["Branch", html`<code class="k-mono">${id.branch}</code>`],
    ["Commit", html`<code class="k-mono">${id.approvedSha}</code>`],
    ["Project", projectName(id.repo)],
    ["Checks", checkAccessWords(id.access)],
  ]);
  const consequence = releaseConsequence(card);
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
      before: html`<section class="k-sec"><h3>What approving does</h3>${joinHtml(consequence.map(line => html`<p class="k-note">${line}</p>`))}${termsHtml(card)}</section>`,
      form: { hidden: { nonce: data.nonce, digest: card.digest, sheet: "release" }, attrs: { class: "k-form", "data-release-approve": card.digest } },
    });
    terms = approvalTerms("standard", data.facts);
  }
  // What, then what changed, then the one decision: its status, CI now, what approving does, every term, the button.
  const formShown = acts !== "" && data.nonce !== "" && card.approved === null && card.refusal === null && data.local === null;
  const body = doc(
    docHeader({ title, back: [taskHref(card.taskId), "Task"], meta: `${projectName(id.repo)} · pull request #${id.pr}` }),
    // A refused approval says why first, above the card it now shows.
    data.problem === null ? "" : notice(data.problem),
    summary,
    changesHtml(card),
    slots({ wait, attrs: { "data-release-sheet": card.taskId }, status, text, acts, terms }),
    notRunning,
    data.held == null ? "" : html`<section class="k-sec" data-release-held><h3>Held after its merge</h3><p class="k-note">${data.held}.</p>${postForm(`${taskHref(card.taskId)}/release/go-on`,
      html`${field({ id: "go-on-password", label: "Your password", control: input({ id: "go-on-password", name: "password", type: "password", attrs: { required: true, autocomplete: "current-password" } }) })}${btn("Let it go on", { variant: "primary", type: "submit" })}`, { attrs: { class: "k-form" } })}</section>`,
    // When the form isn't shown, the consequence and the terms are still on the page.
    formShown ? "" : html`<section class="k-sec"><h3>What approving does</h3>${joinHtml(consequence.map(line => html`<p class="k-note">${line}</p>`))}</section>${termsHtml(card)}`,
  );
  return screen(title, body, { chrome });
}
