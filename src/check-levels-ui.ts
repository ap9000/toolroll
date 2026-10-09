/** Settings → Projects → Checks: how much checks after each build, in plain
 * words. One choice (Quick, Full, Off) and the quick command beside the full
 * one. Every change takes the password and lands in the ledger; approving a
 * command restates exactly what will run, unattended, before the yes. */
import { html, postForm, type Html } from "./html.js";
import { CHECK_LEVELS, CHECK_LEVEL_HINTS, CHECK_LEVEL_WORDS, type CheckLevel } from "./check-levels.js";
import type { VerifyCommand } from "./store.js";
import { BATCH_HINT } from "./batch-policy.js";


export type CheckSettingsView = {
  repo: string;
  name: string;
  csrf: string;
  canChange: boolean;
  level: CheckLevel;
  full: VerifyCommand | null;
  quick: VerifyCommand | null;
  /** A starting point for the quick command, from the project's scripts. */
  suggestion: string | null;
  /** The project's automatic review switch (review-switch.ts), beside its checks. */
  review?: { on: boolean; source: "project" | "hands-off" | "default" };
  /** Batch checks (batch-checks.ts): off by default. */
  batch?: { on: boolean };
  said: string | null;
  problem: string | null;
};

export function checkSettingsHtml(view: CheckSettingsView): Html {
  const post = (act: string, body: Html, attrs: Record<string, string>) => postForm("/settings/checks", body, { attrs, hidden: { repo: view.repo, act } });
  const password = html`<label>Password<input type="password" name="password" autocomplete="current-password" required></label>`;
  const notes = [
    view.said === null ? "" : html`<p class="notice" role="status">${view.said}</p>`,
    view.problem === null ? "" : html`<p class="problem" role="alert">${view.problem}</p>`,
  ];
  const head = html`<p class="meta">${view.name} · <span class="mono">${view.repo}</span></p>${notes}`;
  const command = (one: VerifyCommand) => html`<p class="mono check-command">${one.command}</p><p class="meta">Up to ${Math.round(one.timeoutMs / 1000)}s · approved by ${one.approvedBy}</p>`;
  // Quick with no quick command runs the full check; say so where the choice is made.
  const fallsBack = view.level === "quick" && view.quick === null;
  const current = html`<p><strong>${CHECK_LEVEL_WORDS[view.level]}</strong> · ${CHECK_LEVEL_HINTS[view.level]}</p>${
    fallsBack ? html`<p class="meta">No quick command yet, so builds run the full check.</p>` : ""}${
    view.level !== "full" && view.full !== null ? html`<p class="meta">The full check still runs when a pull request opens, and Merge waits for it.</p>` : ""}`;
  if (!view.canChange) {
    return html`${head}<section class="card check-settings">${current}</section>${batchHtml(view, null)}${reviewHtml(view, null)}<section class="card check-settings"><h2>Quick check</h2>${view.quick === null ? html`<p class="meta">None yet.</p>` : command(view.quick)}</section><section class="card check-settings"><h2>Full check</h2>${view.full === null ? html`<p class="meta">None yet.</p>` : command(view.full)}</section>`;
  }
  const choices = CHECK_LEVELS.map(level =>
    html`<label class="check-choice"><input type="radio" name="level" value="${level}"${level === view.level ? html` checked` : ""}><span><strong>${CHECK_LEVEL_WORDS[level]}</strong><span class="meta">${CHECK_LEVEL_HINTS[level]}</span></span></label>`);
  const levelForm = post("level", html`<fieldset><legend>After each build</legend>${choices}</fieldset>${
    fallsBack ? html`<p class="meta">No quick command yet, so Quick runs the full check.</p>` : ""}<p class="meta">A task can choose its own checks when it's filed. With Quick or Off, the full check runs when a pull request opens, and Merge waits for it unless you merge anyway.</p>${password}<button type="submit">Save</button>`,
    { class: "card check-settings" });
  const quickTerms = html`<ul class="check-terms"><li>Runs unattended right after every Quick build, in that build's checkout.</li><li>Plain environment: no credentials.</li><li>A failure shows on the result; nothing is blocked.</li></ul>`;
  const quickForm = (value: string, submit: string) => post("quick", html`<label>Command<textarea name="command" rows="2" maxlength="2000" spellcheck="false" class="mono" required>${value}</textarea></label><label>Time limit (seconds)<input type="number" name="timeout" min="1" max="3600" value="${view.quick === null ? 180 : Math.round(view.quick.timeoutMs / 1000)}" required></label>${quickTerms}${password}<button type="submit">${submit}</button>`,
    { class: "check-settings" });
  const quick = view.quick === null
    ? html`<section class="card check-settings"><h2>Quick check</h2>${
      view.suggestion === null ? html`<p class="meta">Typecheck and the tests near the change, ideally under 2 minutes.</p>` : html`<p class="meta">Suggested from the project's scripts. Edit it before approving.</p>`}${
      quickForm(view.suggestion ?? "", "Approve quick check")}</section>`
    : html`<section class="card check-settings"><h2>Quick check</h2>${command(view.quick)}<details class="settings-more"><summary>Change quick check</summary>${quickForm(view.quick.command, "Approve change")}</details><details class="settings-more"><summary>Remove quick check</summary>${
      post("quick-clear", html`<p class="meta">Quick builds run the full check instead.</p>${password}<button type="submit" class="danger">Remove</button>`, { class: "check-settings" })}</details></section>`;
  const full = html`<details class="settings-more"><summary>Full check</summary><section class="card check-settings">${
    view.full === null ? html`<p class="meta">None yet. Approve one with <span class="mono">toolroll verify set --repo … --command "…"</span>.</p>` : command(view.full)}</section></details>`;
  return html`${head}${levelForm}${batchHtml(view, password)}${reviewHtml(view, password)}${quick}${full}`;
}

/** Batch checks: one state and one sentence; turning it on restates exactly what happens, behind a disclosure with the password. */
function batchHtml(view: CheckSettingsView, password: Html | null): Html | "" {
  const batch = view.batch;
  if (batch === undefined) return "";
  const act = batch.on ? "Turn off" : "Turn on";
  const terms = batch.on ? html`<p class="meta">Each result runs its own full check again. Results already waiting are checked now.</p>`
    : html`<ul class="check-terms"><li>When results finish within 10 minutes of each other, they're merged in a temporary checkout and the full check runs once.</li><li>If it fails, the batch is split until the result that breaks it is found. Results that conflict are checked on their own.</li><li>Nothing is merged into a real branch. Each result still lands on its own.</li></ul>`;
  const change = password === null ? ""
    : html`<details class="settings-more"><summary>${act}</summary>${postForm("/settings/checks", html`${terms}${password}<button type="submit">${act}</button>`,
      { attrs: { class: "check-settings" }, hidden: { repo: view.repo, act: "batch", on: batch.on ? "0" : "1" } })}</details>`;
  return html`<section class="card check-settings" data-batch-checks="${batch.on ? "on" : "off"}"><h2>Batch checks</h2><p><strong>${batch.on ? "On" : "Off"}</strong> · ${BATCH_HINT}</p>${
    batch.on && view.level !== "full" ? html`<p class="meta">Only Full checks are batched.</p>` : ""}${change}</section>`;
}

/** Automatic review: one state, one sentence, and its one change behind a disclosure (the password). */
function reviewHtml(view: CheckSettingsView, password: Html | null): Html | "" {
  const review = view.review;
  if (review === undefined) return "";
  const state = review.on ? (review.source === "hands-off" ? "On while hands-off lasts" : "On") : "Off";
  const act = review.on ? "Turn off" : "Turn on";
  const change = password === null ? ""
    : html`<details class="settings-more"><summary>${act}</summary>${postForm("/settings/checks", html`${password}<button type="submit">${act}</button>`,
      { attrs: { class: "check-settings" }, hidden: { repo: view.repo, act: "review", on: review.on ? "0" : "1" } })}</details>`;
  return html`<section class="card check-settings" data-review-switch="${review.on ? "on" : "off"}"><h2>Automatic review</h2><p><strong>${state}</strong> · One read-only review after each build passes its checks. Only high findings send it back, once.</p>${change}</section>`;
}

export const CHECK_SETTINGS_CSS = `
  .check-settings { display: grid; gap: .6rem; max-width: 40rem; }
  .check-settings p, .check-settings h2 { margin: 0; }
  .check-settings h2 { font-size: 1rem; }
  .check-settings fieldset { border: 0; margin: 0; padding: 0; display: grid; gap: .25rem; }
  .check-settings legend { font-weight: 600; margin-bottom: .25rem; }
  .check-settings label { display: grid; gap: .25rem; }
  .check-settings .check-choice { display: flex; align-items: flex-start; gap: .6rem; min-height: 44px; padding: .35rem 0; cursor: pointer; }
  .check-settings .check-choice > span { display: grid; gap: .1rem; }
  .check-settings .check-choice input { margin-top: .2rem; }
  .check-settings input[type=password], .check-settings input[type=number], .check-settings textarea { min-height: 44px; box-sizing: border-box; width: 100%; }
  .check-settings button { min-height: 44px; justify-self: start; }
  .check-settings .check-command { overflow-wrap: anywhere; }
  .check-terms { margin: 0; padding-left: 1.1rem; display: grid; gap: .25rem; }
  @media (max-width: 480px) { .check-settings button { justify-self: stretch; } }
  .follow-ups .follow-up-list { margin: .4rem 0; padding-left: 1.1rem; display: grid; gap: .25rem; }
  .follow-ups .follow-up-acts, .follow-ups .follow-up-act { display: flex; flex-wrap: wrap; gap: .5rem; margin: .5rem 0 0; }
  .follow-ups .follow-up-act { margin: 0; }
  .follow-ups button { min-height: 44px; }
  @media (max-width: 480px) { .follow-ups .follow-up-acts, .follow-ups .follow-up-act { display: grid; } .follow-ups .follow-up-act button { width: 100%; } }
`;
