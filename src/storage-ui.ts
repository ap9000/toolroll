/**
 * Settings → Storage: how much space task checkouts use, what a clean-up would free now, a Clean up button whose
 * preview (what goes, what stays and why, with paths) sits behind the password, what the last storage sweep removed
 * and when (its paths in a disclosure), and when a finished task's clean checkout goes by itself. An instance
 * operator's page.
 */
import { homedir } from "node:os";
import { basename } from "node:path";
import { previewDigest, whyWords, type CheckoutItem, type CheckoutPlan } from "./checkout-cleanup.js";
import { CLEANUP_CHOICES, bytesWords } from "./storage.js";
import { sweepDetails, sweepWords, type SweepRecord } from "./storage-sweep.js";

const e = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

export const STORAGE_CSS = `.storage{max-width:720px;min-width:0;overflow-wrap:anywhere}.storage h2{font-size:1.0625rem;margin:24px 0 4px}` +
  `.storage .storage-state{display:grid;gap:12px}.storage .storage-state h2{margin:0}.storage .storage-state p{margin:0}` +
  `.storage details.clean-up,.storage details.discard{border:0;padding:0;margin:0;background:transparent}` +
  `.storage details.clean-up>summary{list-style:none;display:inline-flex;align-items:center;min-height:2.125rem;padding:.35rem .75rem;border-radius:calc(var(--radius) - 3px);` +
  `background:var(--primary);color:var(--primary-foreground);font-weight:600;font-size:.8125rem;cursor:pointer;white-space:nowrap}` +
  `.storage details.clean-up>summary::-webkit-details-marker{display:none}.storage details.clean-up[open]>summary{background:var(--card);color:var(--foreground);border:1px solid var(--input)}` +
  `.storage .preview{display:grid;gap:12px;margin-top:12px;padding-top:12px;border-top:1px solid var(--border)}.storage .preview h3{font-size:.875rem;margin:0}` +
  `.storage ul.checkouts{list-style:none;padding:0;margin:0}` +
  `.storage ul.checkouts li{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:2px 12px;padding:8px 0;border-top:1px solid var(--border);font-size:.8125rem}` +
  `.storage ul.checkouts .name{font-weight:500;min-width:0}.storage ul.checkouts .size{font-variant-numeric:tabular-nums;white-space:nowrap}` +
  `.storage ul.checkouts .path{grid-column:1/-1;font-family:var(--font-mono, ui-monospace, monospace);font-size:.6875rem;color:var(--muted-foreground);word-break:break-all}` +
  `.storage ul.checkouts .why{grid-column:1/-1}` +
  `.storage details.discard{grid-column:1/-1}.storage details.discard>summary{cursor:pointer;color:var(--destructive);min-height:2.25rem;display:inline-flex;align-items:center}` +
  `.storage form{display:grid;gap:10px;margin:0}.storage label{display:grid;gap:4px;font-size:.8125rem;font-weight:500;max-width:20rem}` +
  `.storage select,.storage input[type=password]{width:100%;box-sizing:border-box;min-height:2.125rem}.storage form button{justify-self:start;white-space:nowrap}` +
  `.storage form.setting button[type=submit],.storage .preview form.remove button[type=submit]{background:var(--primary);color:var(--primary-foreground);border-color:var(--primary);font-weight:600}` +
  `.storage .sweep{display:grid;gap:4px}.storage .sweep p{margin:0}.storage .sweep .problem{color:var(--destructive)}` +
  `.storage details.sweep-details>summary{cursor:pointer;min-height:2.25rem;display:inline-flex;align-items:center;font-size:.8125rem;color:var(--muted-foreground)}` +
  `.storage details.sweep-details ul{margin:4px 0 0;padding-left:18px;font-family:var(--font-mono, ui-monospace, monospace);font-size:.6875rem;color:var(--muted-foreground);overflow-wrap:anywhere}` +
  `@media (max-width:900px){.storage details.sweep-details>summary{min-height:44px}.storage details.clean-up>summary,.storage form button{min-height:44px}.storage label{max-width:none}.storage select,.storage input[type=password]{min-height:44px;font-size:16px}.storage .preview form.remove button{width:100%}}`;

export type StorageView = { plan: CheckoutPlan; csrf: string; sweep?: { last: SweepRecord | null; off: boolean } };

/** Paths under the home folder as ~/…, as the checkout list shows them. */
function homeAsTilde(line: string): string {
  const home = homedir();
  return home === "" || home === "/" ? line : line.split(`${home}/`).join("~/");
}

/** "Oct 4, 3:12 AM" in this computer's time. */
function whenWords(at: string): string {
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? at : date.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** One line: when the last sweep ran and what it did; its paths and problems behind Details. */
function sweepHtml(sweep: NonNullable<StorageView["sweep"]>): string {
  const last = sweep.last;
  if (last === null) return `<p class="meta" data-last-sweep="">${sweep.off ? "Automatic sweep is off." : "Toolroll sweeps leftovers once a day. It hasn't run yet."}</p>`;
  const who = last.source === "manual" ? `Cleaned up by ${e(last.actor)}` : "Swept";
  const details = sweepDetails(last.parts);
  const problem = last.parts.some(one => one.failed > 0 || one.problem !== undefined);
  return `<div class="sweep" data-last-sweep="${e(last.at)}"><p${problem ? ' class="problem"' : ""}>${who} <time datetime="${e(last.at)}">${e(whenWords(last.at))}</time>. ${e(sweepWords(last.parts))}</p>` +
    (details.length === 0 ? "" : `<details class="sweep-details"><summary>Details</summary><ul>${details.map(line => `<li>${e(homeAsTilde(line))}</li>`).join("")}</ul></details>`) + `</div>`;
}

function item(one: CheckoutItem, csrf: string): string {
  const discard = one.why === "has changes"
    ? `<details class="discard"><summary>Discard</summary><form method="post" action="/settings/storage/discard"><input type="hidden" name="csrf" value="${e(csrf)}"><input type="hidden" name="path" value="${e(one.path)}">` +
      `<p class="meta">Throws away this checkout and its uncommitted changes. Its branch stays.</p>` +
      `<label>Your Toolroll password<input type="password" name="password" autocomplete="current-password" required></label><button type="submit" class="danger">Discard changes</button></form></details>`
    : "";
  // The task it was for, then where it is (the home folder as ~), then why it stays.
  const home = homedir();
  const where = home !== "" && one.path.startsWith(`${home}/`) ? `~${one.path.slice(home.length)}` : one.path;
  return `<li data-checkout="${e(one.path)}"><span class="name">${e(one.taskId ?? basename(one.path))}</span><span class="size">${e(bytesWords(one.bytes))}</span>` +
    `<span class="path">${e(where)}</span>` +
    (one.why === null ? "" : `<span class="why">${e(whyWords(one)[0]!.toUpperCase() + whyWords(one).slice(1))}</span>`) + discard + `</li>`;
}

export function storageHtml(view: StorageView, notice: { said?: string | null; problem?: string | null }): string {
  const { plan, csrf } = view;
  const note = notice.problem ? `<p class="problem" role="alert">${e(notice.problem)}</p>` : notice.said ? `<p role="status">${e(notice.said)}</p>` : "";
  const hidden = `<input type="hidden" name="csrf" value="${e(csrf)}">`;
  const facts = [plural(plan.count, "checkout"), `${plan.waitingReview} waiting for review`, `${plan.withChanges} kept for their changes`].join(" · ");
  const frees = plan.go.length === 0 ? "Nothing to clean up now." : `Cleaning up now frees about ${bytesWords(plan.freeBytes)}.`;
  const remove = plan.go.length === 0 ? "" :
    `<form method="post" action="/settings/storage/clean" class="remove">${hidden}<input type="hidden" name="preview" value="${e(previewDigest(plan))}">` +
    `<label>Your Toolroll password<input type="password" name="password" autocomplete="current-password" required></label>` +
    `<button type="submit">Remove ${plural(plan.go.length, "checkout")}</button></form>`;
  const preview = `<details class="clean-up" data-clean-up${notice.problem?.startsWith("Enter your Toolroll password to clean") ? " open" : ""}><summary>Clean up</summary><div class="preview">` +
    (plan.go.length === 0 ? `<p>Nothing to remove now.</p>` :
      `<h3>Removes ${plural(plan.go.length, "checkout")}, about ${e(bytesWords(plan.freeBytes))}</h3><p class="meta">Their branches stay, so nothing committed is lost.</p>` +
      `<ul class="checkouts" data-goes>${plan.go.map(one => item(one, csrf)).join("")}</ul>`) +
    (plan.stay.length === 0 ? "" : `<h3>Stays (${plan.stay.length})</h3><ul class="checkouts" data-stays>${plan.stay.map(one => item(one, csrf)).join("")}</ul>`) +
    remove + `</div></details>`;
  const options = CLEANUP_CHOICES.map(one => `<option value="${one.value}"${one.value === plan.cleanup ? " selected" : ""}>${e(one.label)}</option>`).join("");
  return `<section class="storage">${note}` +
    `<div class="card storage-state"><h2 data-checkout-bytes="${plan.totalBytes}">Checkouts use ${e(bytesWords(plan.totalBytes))}</h2><p class="meta">${e(facts)}</p>` +
    `<p data-clean-bytes="${plan.freeBytes}">${e(frees)}</p>${view.sweep === undefined ? "" : sweepHtml(view.sweep)}${preview}</div>` +
    `<h2>Automatic cleanup</h2>` +
    `<form method="post" action="/settings/storage" class="setting">${hidden}` +
    `<label>Remove a finished task's clean checkout<select name="cleanup">${options}</select></label>` +
    `<p class="meta">Its branch always stays. Checkouts with changes, commits on no branch, in use, or waiting for review are kept.</p>` +
    `<label>Your Toolroll password<input type="password" name="password" autocomplete="current-password" required></label><button type="submit">Save</button></form></section>`;
}
