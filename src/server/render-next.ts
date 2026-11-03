/**
 * /next (Wave E, src/design/KIT.md): everything waiting on a person, one at a time, each in the approval slots with
 * its one act, every act landing back here. The forms post exactly what they always have (the approve form's nonce,
 * digest and password; a decision's choice, confirm and note; a requeue), so every server check is unchanged. The
 * approval shows the password only when the rules ask (approveForm, standard): none with Passwordless or a remembered
 * password the task page's own preview says may approve these exact terms; otherwise the password, required.
 */
import { originNote, type TaskOrigin } from "../task-source.js";
import { html, joinHtml, postForm, type Html } from "../html.js";
import type { Gap } from "../gaps.js";
import type { Scope } from "../scope.js";
import type { Decision } from "../store.js";
import { type Chrome, screen, type Screen, when } from "./chrome.js";
import { taskHref } from "./http.js";
import {
  acceptanceCeremonyHtml, agentsCeremonyHtml, consentClosedHtml, type ConsentDoor, consentDoorOf, executionPlanHtml, planContractHtml,
  type PlanContractView, profileWords, type RouteView, runtimeDetailsHtml,
} from "./render-tasks.js";
import { approvalFactsNow, approvalTerms, approveForm, btn, chip, disclose, doc, docHeader, empty, facts, note, phoneHeader, slots } from "./kit.js";

export type NextItem =
  | { key: string; kind: "decision"; decision: Decision & { taskId: string } }
  | { key: string; kind: "approval"; approval: { taskId: string; title: string; goal: string; digest: string; proposedAt: string } }
  | { key: string; kind: "requeue"; stalled: { taskId: string; title: string; strikes: number; incidentCount: number } }
  | { key: string; kind: "gap"; gap: Gap }
  | null;

/** One decision option: a one-click answer (an irreversible one behind its own disclosure, with the confirm the server
 * requires) and its consequence. A note travels from the task's own page. */
function optionForm(decision: Decision, option: Decision["options"][number]): Html {
  const recommended = option.id === decision.recommendation;
  const form = postForm(`/d/${decision.id}/answer`, html`<div class="k-acts">${btn(option.label, { variant: option.reversible ? (recommended ? "primary" : "outline") : "danger", type: "submit" })}</div>\
<p class="k-note">${recommended ? html`${chip("Recommended", "", { dot: false })} ` : ""}${option.consequence}</p>`,
  { attrs: { class: "k-form" }, returnTo: "next", hidden: { choice: option.id, confirm: option.reversible ? null : "yes" } });
  return option.reversible ? form : disclose(`${option.label} (can't be undone)`, form);
}

export function nextPage(chrome: Chrome, data: {
  item: NextItem;
  scope: Scope | null;
  planDocument: string | null;
  planContract?: PlanContractView | null;
  approvalDigest: string | null;
  /** v34: said inside the ceremony when the yes buys a report, not a branch. */
  deliverable?: "branch" | "report";
  /** v48: the agents the yes freezes — the one block every ceremony shows. */
  route: RouteView | null;
  /** v126: where the work came from (an outside event's line of context, never a term agreed to). */
  origin?: TaskOrigin | null;
  /** A remembered password stands in for these exact terms (the task page's preview): one click, no field. */
  remembered?: boolean;
  csrf: string;
  nonce: string;
  remaining: number;
  skipped: string[];
  now: Date;
}): Screen {
  const { item } = data;
  const title = "Needs you";
  if (item === null) {
    const held = data.skipped.length;
    return screen(title, html`${phoneHeader(title)}${doc(docHeader({ title, same: true }), held > 0
      ? empty({ title: `Only the ${held} you set aside ${held === 1 ? "is" : "are"} left.`, text: "Look at them again now, or come back later.", action: btn("Look at them again", { sm: true, href: "/next" }) })
      : empty({ title: "Nothing needs you.", text: "Everything is either working or waiting on its own clock.", action: btn("Open Tasks", { sm: true, href: "/work" }) }))}`, { chrome });
  }

  const skipHref = `/next?skip=${encodeURIComponent([...data.skipped, item.key].join(","))}`;
  const header = docHeader({
    title, same: true,
    meta: data.remaining === 1 ? "The last thing waiting on you" : `1 of ${data.remaining} waiting on you`,
    right: btn("Not now", { variant: "ghost", sm: true, href: skipHref }),
  });
  const openTask = (taskId: string, words = "Open the task"): Html => html`<a class="k-link" href="${taskHref(taskId)}">${words}</a>`;

  let card: Html;
  if (item.kind === "decision") {
    const { decision } = item;
    card = slots({
      wait: true, attrs: { "data-decision": String(decision.id) },
      status: html`${chip("Question", "ask")}<h2>${decision.question}</h2>`,
      text: decision.recap,
      acts: joinHtml(decision.options.map(option => optionForm(decision, option))),
      terms: html`${decision.taskId} · asked ${when(decision.createdAt)} · ${openTask(decision.taskId, "Answer with a note on the task")}`,
    });
  } else if (item.kind === "approval" && !consentDoorOf(data.scope, data.route).open) {
    const door = consentDoorOf(data.scope, data.route) as ConsentDoor & { open: false };
    card = slots({
      wait: true,
      status: html`${chip("Plan", "ask")}<h2>${item.approval.title}</h2>`,
      text: item.approval.taskId,
      acts: consentClosedHtml(item.approval.taskId, door, "next"),
      terms: openTask(item.approval.taskId),
    });
  } else if (item.kind === "approval") {
    const scope = data.scope;
    const facts_ = approvalFactsNow({ remembered: data.remembered === true });
    const terms = joinHtml([
      data.deliverable === "report" ? note("Research only: a read-only session investigates this goal and delivers a report. No branch; nothing in the repository changes.") : "",
      scope === null || scope.profileState !== "unresolved" ? "" : profileWords(scope),
      originNote(data.origin) === null ? "" : html`<p class="k-note" data-approval-origin>${originNote(data.origin)!}</p>`,
      facts([
        ["Goal", scope?.goal ?? item.approval.goal],
        ["Not this", scope?.outOfScope == null ? "No exclusions" : scope.outOfScope],
        ["Touches", scope === null || scope.touches.length === 0 ? "Anything" : scope.touches.join(", ")],
      ]),
      scope === null ? "" : acceptanceCeremonyHtml(scope.acceptance),
      // The agents the yes freezes (v48): the same block the task page and chat sign under, before the password.
      agentsCeremonyHtml(data.route),
      scope === null ? "" : runtimeDetailsHtml(scope),
    ]);
    const plan = data.planDocument === null ? "" : html`<section class="k-sec"><h3>The plan</h3>${executionPlanHtml(data.planDocument, true)}${planContractHtml(data.planContract ?? null, "ceremony")}</section>`;
    const digest = data.approvalDigest ?? item.approval.digest;
    // The terms ride inside the form, before the password: what the yes covers is on the form that says it.
    card = html`${plan}${slots({
      wait: true, attrs: { "data-approval": digest },
      status: html`${chip("Plan", "ask")}<h2>${item.approval.title}</h2>`,
      text: html`${item.approval.taskId} · ${openTask(item.approval.taskId, "Open the task to change the scope first")}`,
      acts: approveForm({ action: `${taskHref(item.approval.taskId)}/approve`, kind: "standard", facts: facts_, label: "Approve and start", primary: true,
        before: html`<section class="k-sec"><h3>Approve exactly this</h3>${terms}</section>`,
        form: { returnTo: "next", hidden: { nonce: data.nonce, digest }, attrs: { class: "k-form" } } }),
      terms: approvalTerms("standard", facts_),
    })}`;
  } else if (item.kind === "requeue") {
    card = slots({
      wait: true,
      status: html`${chip("Stopped", "ask")}<h2>${item.stalled.title}</h2>`,
      text: `Stopped with ${item.stalled.incidentCount} incident${item.stalled.incidentCount === 1 ? "" : "s"}${item.stalled.strikes > 0 ? ` after ${item.stalled.strikes} attempt${item.stalled.strikes === 1 ? "" : "s"}` : ""}. Retrying resolves the incidents, clears the failed attempts and puts it back in line.`,
      acts: postForm(`${taskHref(item.stalled.taskId)}/requeue`, btn("Retry this work", { variant: "primary", type: "submit" }), { returnTo: "next" }),
      terms: html`${item.stalled.taskId} · ${openTask(item.stalled.taskId, "Read the attempts first")}`,
    });
  } else {
    const { gap } = item;
    card = slots({
      wait: true,
      status: html`${chip("Missing", "ask")}<h2>Supply ${gap.key}</h2>`,
      text: html`${gap.state}. Filling it starts ${gap.unblocks.length} task${gap.unblocks.length === 1 ? "" : "s"}: ${joinHtml(gap.unblocks.map(one => html`<span class="k-mono">${one}</span>`), ", ")}.`,
      acts: "",
      terms: html`Prove it is filled from a terminal: <code class="k-mono">${gap.verify}</code>`,
    });
  }
  return screen(title, html`${phoneHeader(title)}${doc(header, card)}`, { chrome });
}
