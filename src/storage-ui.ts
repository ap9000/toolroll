/**
 * Settings → Storage: how much space task checkouts use, what a clean-up would free now, the clean-up's preview (what
 * goes, what stays and why, with paths) and its Remove behind the password, what the last storage sweep removed and
 * when (its paths in a disclosure) and why the next one waits, what landed work's teardown did and still waits on (in a
 * disclosure, with the one-time command for older work), and when a finished task's clean checkout goes by itself. An
 * instance operator's page, built from the revamp kit; the Settings frame adds the title.
 */
import { homedir } from "node:os";
import { basename } from "node:path";
import { html, joinHtml, type Html } from "./html.js";
import { previewDigest, whyWords, type CheckoutItem, type CheckoutPlan } from "./checkout-cleanup.js";
import { CLEANUP_CHOICES, bytesWords } from "./storage.js";
import { sweepDetails, sweepWords, type SweepRecord } from "./storage-sweep.js";
import { sweepScheduleWords, type SweepSchedule } from "./storage-sweep-schedule.js";
import type { LandedSummary } from "./landed-cleanup.js";
import { codeLine, disclose, formRow, icon, infoLine, note, notice, select, settingsRecord, settingsSection } from "./server/kit.js";
import { kitSectionForm } from "./settings-kit.js";

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** The page is kit pieces now; nothing of the old look is left. Kept as an export for the shared stylesheet. */
export const STORAGE_CSS = "";

export type StorageView = { plan: CheckoutPlan; csrf: string; sweep?: { last: SweepRecord | null; off: boolean; schedule?: SweepSchedule }; landed?: LandedSummary;
  /** When the checkouts were last measured, and its Check now (docs/plans/get-side-effects.md). */
  measured?: Html };

/** A path under the home folder as ~/…. */
function tilde(path: string): string {
  const home = homedir();
  return home !== "" && home !== "/" && path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}
/** Paths under the home folder as ~/… anywhere in a line, as the checkout list shows them. */
function homeAsTilde(line: string): string {
  const home = homedir();
  return home === "" || home === "/" ? line : line.split(`${home}/`).join("~/");
}

/** "Oct 4, 3:12 AM" in this computer's time. */
function whenWords(at: string): string {
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? at : date.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** When the last sweep ran and what it did, then why the next one waits or when it is due; paths and problems behind Details. */
function sweepHtml(sweep: NonNullable<StorageView["sweep"]>): Html {
  const last = sweep.last;
  const schedule = sweep.schedule === undefined ? (sweep.off ? html`<p class="k-note" data-sweep-state="off">Automatic sweep: off.</p>` : "")
    : html`<p class="k-note" data-sweep-state="${sweep.schedule.state}">Automatic sweep: ${sweepScheduleWords(sweep.schedule, whenWords)}</p>`;
  if (last === null) return html`<div data-last-sweep="">${note("Not swept yet.")}${schedule}</div>`;
  const who = last.source === "manual" ? `Cleaned up by ${last.actor}` : "Swept";
  const details = sweepDetails(last.parts);
  const problem = last.parts.some(one => one.failed > 0 || one.problem !== undefined);
  const said = html`${who} <time datetime="${last.at}">${whenWords(last.at)}</time>. ${sweepWords(last.parts)}`;
  return html`<div data-last-sweep="${last.at}">${problem ? html`<p class="k-notice" role="alert">${icon("alert", true)}<span>${said}</span></p>` : note(said)}${schedule}${
    details.length === 0 ? "" : disclose("Details", joinHtml(details.map(line => codeLine(homeAsTilde(line)))))}</div>`;
}

/** Landed work, on demand: what its teardown did, what it waits on and why, and the one-time command for older work. */
function landedHtml(landed: LandedSummary): Html {
  const done = landed.completed + landed.checkouts + landed.branches === 0 ? "No landed work cleaned up yet."
    : `${plural(landed.completed, "task")} marked complete; ${plural(landed.checkouts, "checkout")} and ${plural(landed.branches, "local branch", "local branches")} removed.`;
  const waiting = landed.waiting.length === 0 ? "" : html`<div data-landed-waiting>${note(`Waiting (${landed.waiting.length}):`)}${landed.waiting.map(one =>
    settingsRecord({ title: html`<span class="k-mono">${tilde(one.target)}</span>`, sub: one.why ?? "" }))}</div>`;
  return html`<div data-landed>${disclose("Landed work", joinHtml([note(done), waiting,
    note(html`For work that landed before this: <code class="k-mono">toolroll storage clean --landed</code> shows what would go; add <code class="k-mono">--yes</code> to do it.`)]))}</div>`;
}

/** One checkout: the task it was for, its size, where it is (the home folder as ~), why it stays, and Discard when it has changes. */
function item(one: CheckoutItem): Html {
  const why = one.why === null ? "" : `${whyWords(one)[0]!.toUpperCase()}${whyWords(one).slice(1)}`;
  const discard = one.why === "has changes"
    ? disclose("Discard", kitSectionForm({ proof: "storage-discard", action: "/settings/storage/discard", id: `discard-${previewId(one.path)}`, hidden: { path: one.path },
        save: { label: "Discard changes", variant: "danger" }, body: note("Throws away this checkout and its uncommitted changes. Its branch stays.") }))
    : "";
  return settingsRecord({ title: one.taskId ?? basename(one.path), attrs: { "data-checkout": one.path }, when: bytesWords(one.bytes),
    sub: html`<span class="k-mono">${tilde(one.path)}</span>${why === "" ? "" : ` · ${why}`}`, more: discard });
}
/** A short id for a checkout's form, from its path. */
const previewId = (path: string): string => path.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").slice(-48) || "checkout";

export function storageHtml(view: StorageView, said: { said?: string | null; problem?: string | null }): Html {
  const { plan } = view;
  const facts = [plural(plan.count, "checkout"), `${plan.waitingReview} waiting for review`, `${plan.withChanges} kept for their changes`].join(" · ");
  const frees = plan.go.length === 0 ? "Nothing to clean up now." : `Cleaning up now frees about ${bytesWords(plan.freeBytes)}.`;
  const checkouts = settingsSection({ id: "checkouts", title: `Checkouts use ${bytesWords(plan.totalBytes)}`,
    body: joinHtml([
      said.problem ? notice(said.problem) : said.said ? infoLine(said.said) : "",
      html`<p class="k-note" data-checkout-bytes="${plan.totalBytes}">${facts}</p>`,
      view.measured ?? "",
      html`<p class="k-note" data-clean-bytes="${plan.freeBytes}">${frees}</p>`,
      view.sweep === undefined ? "" : sweepHtml(view.sweep),
      view.landed === undefined ? "" : landedHtml(view.landed),
    ]) });
  const remove = plan.go.length === 0 ? "" : kitSectionForm({ proof: "storage-clean", action: "/settings/storage/clean", id: "clean-form", hidden: { preview: previewDigest(plan) },
    save: { label: `Remove ${plural(plan.go.length, "checkout")}`, variant: "danger" }, body: html`` });
  const goes = plan.go.length === 0 ? note("Nothing to remove now.")
    : html`<div data-goes>${plan.go.map(one => item(one))}</div>`;
  const stays = plan.stay.length === 0 ? "" : disclose(`Stays (${plan.stay.length})`, html`<div data-stays>${plan.stay.map(one => item(one))}</div>`);
  const cleanUp = settingsSection({ id: "clean-up", title: "Clean up now",
    lead: plan.go.length === 0 ? "Nothing to remove now." : `Removes ${plural(plan.go.length, "checkout")}, about ${bytesWords(plan.freeBytes)}. Their branches stay, so nothing committed is lost.`,
    body: html`<div data-clean-up>${joinHtml([plan.go.length === 0 ? "" : goes, remove, stays])}</div>` });
  const automatic = settingsSection({ id: "automatic-cleanup", title: "Automatic cleanup",
    lead: "Its branch stays. Checkouts with changes, commits on no branch, in use, or waiting for review are kept. When a task's work is already in main, Toolroll marks it complete and removes its checkout and local branches.",
    body: kitSectionForm({ proof: "storage-cleanup", action: "/settings/storage", id: "cleanup-form", gate: true,
      body: formRow("Remove a finished task's clean checkout", null, select({ id: "storage-cleanup", name: "cleanup", label: "Remove a finished task's clean checkout", current: plan.cleanup,
        items: CLEANUP_CHOICES.map(one => [one.value, one.label] as const) }), "inline") }) });
  return joinHtml([checkouts, cleanUp, automatic]);
}
