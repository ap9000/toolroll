/**
 * Settings → Updates: the installed version, one of three ways to update
 * (behind the operator's password), the update's steps live while it runs,
 * and a one-time "What's new" card afterwards. The work itself is the
 * `toolroll update` command (toolroll-update.ts), started as its own job.
 */
import { html, postForm, replaceMarkup, type Html } from "./html.js";
import type { InstallMethod } from "./install-method.js";
import { STEP_WORDS, UPDATE_STEPS, runtimeUpdateTerminal, type RuntimeUpdateJournal, type UpdateStep } from "./toolroll-update.js";

const clock = (iso: string) => { const d = new Date(iso); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };

export const UPDATES_CSS = `.updates{max-width:640px;min-width:0;overflow-wrap:anywhere}.updates .card{margin:0 0 16px}.updates h2{margin:0;font-size:1.0625rem}.updates .card>p{margin:4px 0 0}` +
  `.updates .update-actions{display:flex;flex-wrap:wrap;gap:8px;margin:16px 0 0}.updates .update-actions button{white-space:nowrap}` +
  `.updates button.primary{background:var(--primary);color:var(--primary-foreground);border-color:var(--primary);font-weight:600}` +
  `.updates .step-up{display:grid;gap:4px;font-size:.8125rem;margin:16px 0 0;max-width:20rem}.updates .step-up input{min-height:40px}` +
  `.updates ol.update-steps{list-style:none;padding:0;margin:14px 0 0;display:grid;gap:2px}.updates ol.update-steps li{display:grid;grid-template-columns:18px minmax(0,1fr);gap:0 10px;align-items:baseline;padding:5px 0;font-size:.875rem;color:var(--so-muted)}` +
  `.updates ol.update-steps li::before{content:"";width:8px;height:8px;border-radius:50%;border:1.5px solid var(--so-input-line);justify-self:center;transform:translateY(-1px)}` +
  `.updates ol.update-steps li[data-state=done]{color:var(--so-ink)}.updates ol.update-steps li[data-state=done]::before{background:var(--so-success);border-color:var(--so-success)}` +
  `.updates ol.update-steps li[data-state=now]{color:var(--so-ink);font-weight:600}.updates ol.update-steps li[data-state=now]::before{background:var(--so-info);border-color:var(--so-info);box-shadow:0 0 0 4px color-mix(in srgb,var(--so-info) 16%,transparent)}` +
  `.updates ol.update-steps li[data-state=failed]{color:var(--so-danger);font-weight:600}.updates ol.update-steps li[data-state=failed]::before{background:var(--so-danger);border-color:var(--so-danger)}` +
  `.updates ol.update-steps .step-detail{grid-column:2;font-weight:400;color:var(--so-muted);font-size:.8125rem;margin-top:2px}` +
  `.updates .whats-new ul{margin:10px 0 0;padding-left:18px}.updates .whats-new li{margin:4px 0}.updates .whats-new form{margin:14px 0 0}` +
  `.updates .update-problem{color:var(--so-danger)}.updates .stamp{margin:10px 0 0}.updates code{white-space:nowrap}.updates [data-update-outcome=stopped] code,.updates .step-detail code{white-space:normal;overflow-wrap:anywhere}` +
  `@media (prefers-reduced-motion:no-preference){.updates ol.update-steps li[data-state=now]::before{animation:update-pulse 1.6s ease-in-out infinite}}@keyframes update-pulse{50%{box-shadow:0 0 0 7px color-mix(in srgb,var(--so-info) 6%,transparent)}}` +
  `@media (max-width:600px){.updates .update-actions{display:grid}.updates .update-actions button{width:100%;min-height:44px}.updates .step-up{max-width:none}.updates .step-up input{min-height:44px}}`;

export type UpdatesView = {
  current: string;
  /** The newest release, why it is unknown, or not asked because update checks are off. */
  latest: { version: string } | { problem: string } | { off: true };
  method: InstallMethod;
  journal: RuntimeUpdateJournal | null;
  running: boolean;
  whatsNew: { version: string; notes: string[] } | null;
  /** The version `toolroll update --rollback` returns to: the last completed update's, while it is what runs. */
  rollbackTo: string | null;
  csrf: string;
};

/** The steps, each done, current, failed or waiting. Also the live region's fragment. */
export function updateStepsHtml(j: RuntimeUpdateJournal, running: boolean): Html {
  const finished = runtimeUpdateTerminal(j.phase);
  const failed = ["restored", "refused", "needs-attention", "rolling-back"].includes(j.phase);
  const last = UPDATE_STEPS.indexOf([...j.steps].reverse().find(s => (UPDATE_STEPS as readonly string[]).includes(s.phase))?.phase as UpdateStep);
  const items = UPDATE_STEPS.map((step: UpdateStep, i) => {
    const state = j.phase === "complete" || i < last ? "done" : i > last ? "waiting" : failed ? "failed" : finished ? "waiting" : "now";
    // Only where it adds something: which work it waits for, or what went wrong.
    const detail = state === "now" && step === "draining" && j.waiting ? html`<span class="step-detail">${j.waiting.on}.${j.waiting.action ? html` If nothing of it is running, run <code>${j.waiting.action}</code>.` : ""}</span>`
      : (state === "now" && step === "draining") || (state === "failed" && j.phase === "rolling-back") ? html`<span class="step-detail">${j.detail}</span>` : "";
    return html`<li data-step="${step}" data-state="${state}">${STEP_WORDS[step]}${detail}</li>`;
  });
  const title = j.phase === "scheduled" ? `Update to ${j.to.version} scheduled for ${clock(j.at ?? j.startedAt)}`
    : j.phase === "rolling-back" ? `Restoring ${j.from.version}`
    : j.kind === "rollback" ? `Rolling back to ${j.to.version}` : `Updating to ${j.to.version}`;
  const stalled = !running && !finished ? html`<p class="update-problem" role="alert">The updater stopped. Run <code>toolroll update --resume</code> to continue it.</p>` : "";
  return html`<div id="update-live" data-phase="${j.phase}" data-done="${finished ? 1 : 0}"><h2>${title}</h2>${
    j.phase === "scheduled" ? html`<p class="meta">Running work finishes first. You can close this page.</p>` : html`<ol class="update-steps" aria-label="Update steps">${items}</ol>`}${stalled}</div>`;
}

function outcomeHtml(j: RuntimeUpdateJournal): Html | "" {
  if (j.phase === "complete") return j.kind === "rollback" ? html`<div class="card" data-update-outcome="rolled-back"><h2>Back on ${j.to.version}</h2><p class="meta">${j.detail}</p></div>` : "";
  if (j.phase === "cancelled") return html`<div class="card" data-update-outcome="cancelled"><h2>Update cancelled</h2><p class="meta">Nothing changed.</p></div>`;
  // Stopped on a finished run it can't show has ended: what is in the way and the one command, nothing more.
  if (j.phase === "refused" && j.waiting) return html`<div class="card" data-update-outcome="stopped"><h2>Update to ${j.to.version} stopped: run #${j.waiting.run} is in the way</h2><p>${j.waiting.on}. New work resumed.</p>${
    j.waiting.action ? html`<p class="meta">If nothing of it is running, run <code>${j.waiting.action}</code>, then update again.</p>` : html`<p class="meta">Update again once it has stopped.</p>`}</div>`;
  const title = j.phase === "refused" ? html`Didn't update to ${j.to.version}` : j.phase === "restored" ? html`Update to ${j.to.version} didn't finish` : "The update needs attention";
  return html`<div class="card" data-update-outcome="${j.phase}"><h2>${title}</h2><p class="${j.phase === "needs-attention" ? "update-problem" : ""}" role="alert">${j.detail}</p><details><summary>Steps</summary>${replaceMarkup(updateStepsHtml(j, false), /<h2>.*?<\/h2>/, () => html``)}</details></div>`;
}

export function updatesHtml(view: UpdatesView, notice: { said?: string | null; problem?: string | null }): Html {
  const note = notice.problem ? html`<p class="update-problem" role="alert">${notice.problem}</p>` : notice.said ? html`<p role="status">${notice.said}</p>` : "";
  const j = view.journal;
  const active = j !== null && !runtimeUpdateTerminal(j.phase);
  const whatsNew = view.whatsNew === null ? "" : html`<div class="card whats-new" data-whats-new="${view.whatsNew.version}"><h2>What’s new in ${view.whatsNew.version}</h2>${
    view.whatsNew.notes.length > 0 ? html`<ul>${view.whatsNew.notes.map(line => html`<li>${line}</li>`)}</ul>` : ""}<p class="meta"><a href="https://github.com/ap9000/toolroll/releases/tag/v${view.whatsNew.version}" rel="noreferrer">Full release notes</a></p>${
    postForm("/settings/updates/seen", html`<button type="submit">Got it</button>`)}</div>`;
  if (active) {
    const cancel = ["scheduled", "draining"].includes(j.phase) ? postForm("/settings/updates/cancel", html`<button type="submit">Cancel update</button>`, { attrs: { class: "update-actions" } }) : "";
    return html`<section class="updates">${note}<div class="card" id="update-region">${updateStepsHtml(j, view.running)}${cancel}</div><p class="meta stamp" id="update-region-stamp"></p></section>`;
  }
  const latest = "version" in view.latest ? view.latest.version : null;
  const newer = latest !== null && newerThan(latest, view.current);
  const state = view.method.kind === "npx" ? html`<h2>Toolroll ${view.current}</h2><p class="meta">npx runs the latest release each time, so this is current.</p>`
    : view.method.kind === "source" ? html`<h2>Toolroll ${view.current}</h2><p class="meta">This runs from a source checkout. Update it with git.</p>`
    : newer && view.method.kind === "desktop" ? html`<h2>Toolroll ${latest} is available</h2><p class="meta">You have ${view.current}. Update it from the Toolroll app.</p>`
    : newer ? html`<h2>Toolroll ${latest} is available</h2><p class="meta">You have ${view.current}. Running work finishes first, and your current version is kept so you can go back.</p>`
    : "off" in view.latest ? html`<h2>Toolroll ${view.current}</h2><p class="meta">Update checks are off.</p><form method="get" action="/settings/updates" class="update-actions"><input type="hidden" name="check" value="now"><button type="submit">Check now</button></form>`
    : latest === null ? html`<h2>Toolroll ${view.current}</h2><p class="meta">Couldn’t check for a newer release: ${"problem" in view.latest ? view.latest.problem : ""}</p>`
    : html`<h2>Toolroll ${view.current} is up to date</h2>`;
  const form = newer && !["npx", "source", "desktop"].includes(view.method.kind)
    ? postForm("/settings/updates", html`<label class="step-up">Your Toolroll password<input type="password" name="password" autocomplete="current-password" required></label><div class="update-actions"><button type="submit" name="when" value="now" class="primary">Update now</button><button type="submit" name="when" value="when-idle">When idle</button><button type="submit" name="when" value="tonight">Tonight (03:00)</button></div>`, { hidden: { version: latest } })
    : "";
  const rollback = view.rollbackTo !== null ? html`<p class="meta">To go back to ${view.rollbackTo}: <code>toolroll update --rollback</code></p>` : "";
  return html`<section class="updates">${note}${whatsNew}${j ? outcomeHtml(j) : ""}<div class="card" data-update-state="${newer ? "available" : "current"}">${state}${form}${rollback}</div></section>`;
}

export function newerThan(a: string, b: string): boolean {
  const [x, y] = [a, b].map(v => v.split(".").map(Number));
  for (let i = 0; i < 3; i++) if ((x![i] ?? 0) !== (y![i] ?? 0)) return (x![i] ?? 0) > (y![i] ?? 0);
  return false;
}

/** Polls the steps every two seconds, keeps trying while the console
 * restarts, and reloads once the update has finished. */
export function updatesScript(): string {
  return `(function(){var region=document.getElementById("update-region");if(!region)return;var stamp=document.getElementById("update-region-stamp");var misses=0;` +
    `function tick(){if(document.hidden){setTimeout(tick,2000);return;}fetch("/settings/updates?fragment=steps",{credentials:"same-origin",cache:"no-store"}).then(function(r){if(!r.ok)throw 0;return r.text();}).then(function(html){misses=0;if(stamp)stamp.textContent="";` +
    `var live=region.querySelector("#update-live");if(live)live.outerHTML=html;var now=region.querySelector("#update-live");if(now&&now.getAttribute("data-done")==="1"){location.reload();return;}setTimeout(tick,2000);})` +
    `.catch(function(){misses++;if(stamp)stamp.textContent=misses>2?"Reconnecting while Toolroll restarts…":"";setTimeout(tick,Math.min(10000,2000*misses));});}setTimeout(tick,2000);})();`;
}
