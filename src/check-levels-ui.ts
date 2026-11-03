/** Settings → Projects → Checks: how much checks after each build, in plain
 * words. One choice (Quick, Full, Off) and the quick command beside the full
 * one. Every change takes the password and lands in the ledger; approving a
 * command restates exactly what will run, unattended, before the yes. */
import { html, joinHtml, type Html } from "./html.js";
import { CHECK_LEVELS, CHECK_LEVEL_HINTS, CHECK_LEVEL_WORDS, type CheckLevel } from "./check-levels.js";
import type { VerifyCommand } from "./store.js";
import { BATCH_HINT } from "./batch-policy.js";
import { codeLine, disclose, formRow, infoLine, input, note, notice, radios, settingsSection, textarea } from "./server/kit.js";
import { kitSectionForm } from "./settings-kit.js";


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

const list = (items: readonly string[]): Html => html`<ul class="k-note">${items.map(one => html`<li>${one}</li>`)}</ul>`;

export function checkSettingsHtml(view: CheckSettingsView): Html {
  const form = (id: string, act: string, body: Html, save: { label: string; variant?: "primary" | "outline" | "danger" }, extra: Record<string, string> = {}) =>
    kitSectionForm({ proof: "checks", action: "/settings/checks", id, hidden: { repo: view.repo, act, ...extra }, save, body });
  const head = joinHtml([
    view.problem === null ? "" : notice(view.problem),
    view.said === null ? "" : infoLine(view.said),
    note(html`${view.name} · <span class="k-mono">${view.repo}</span>`),
  ]);
  const command = (one: VerifyCommand) => joinHtml([codeLine(one.command), note(`Up to ${Math.round(one.timeoutMs / 1000)}s · approved by ${one.approvedBy}`)]);
  // Quick with no quick command runs the full check; say so where the choice is made.
  const fallsBack = view.level === "quick" && view.quick === null;
  const levelNotes = joinHtml([
    fallsBack ? note("No quick command yet, so builds run the full check.") : "",
    view.level !== "full" && view.full !== null ? note("The full check still runs when a pull request opens, and Merge waits for it.") : "",
  ]);
  const level = settingsSection({ id: "check-level", title: "After each build", state: ` · ${CHECK_LEVEL_WORDS[view.level]}`, lead: CHECK_LEVEL_HINTS[view.level],
    body: !view.canChange ? levelNotes : joinHtml([levelNotes, kitSectionForm({ proof: "checks", action: "/settings/checks", id: "check-level-form", gate: true,
      hidden: { repo: view.repo, act: "level" }, confirm: "Change checks",
      body: joinHtml([
        formRow("After each build", "A task can choose its own checks when it's filed. With Quick or Off, the full check runs when a pull request opens, and Merge waits for it unless you merge anyway.",
          radios({ name: "level", legend: "After each build", current: view.level, items: CHECK_LEVELS.map(one => ({ value: one, label: CHECK_LEVEL_WORDS[one], text: CHECK_LEVEL_HINTS[one] })) }), "wide"),
      ]) })]) });
  const commandForm = (id: string, value: string, submit: string) => form(id, "quick", joinHtml([
    formRow("Command", null, textarea({ id: `${id}-command`, name: "command", value, rows: 2, attrs: { maxlength: 2000, spellcheck: "false", required: true, "aria-label": "Command" } }), "wide"),
    formRow("Time limit", "Seconds, up to 3600.", input({ id: `${id}-timeout`, name: "timeout", type: "number", value: String(view.quick === null ? 180 : Math.round(view.quick.timeoutMs / 1000)),
      attrs: { min: 1, max: 3600, required: true, "aria-label": "Time limit in seconds" } }), "inline"),
    list(["Runs unattended right after every Quick build, in that build's checkout.", "Plain environment: no credentials.", "A failure shows on the result; nothing is blocked."]),
  ]), { label: submit, variant: "outline" });
  const quick = settingsSection({ id: "quick-check", title: "Quick check", state: view.quick === null ? " · None yet" : "",
    lead: view.quick === null && view.canChange
      ? view.suggestion === null ? "Typecheck and the tests near the change, ideally under 2 minutes." : "Suggested from the project's scripts. Edit it before approving."
      : undefined,
    body: view.quick === null
      ? view.canChange ? commandForm("quick-form", view.suggestion ?? "", "Approve quick check") : ""
      : joinHtml([command(view.quick), !view.canChange ? "" : joinHtml([
          disclose("Change quick check", commandForm("quick-change-form", view.quick.command, "Approve change")),
          disclose("Remove quick check", form("quick-clear-form", "quick-clear", note("Quick builds run the full check instead."), { label: "Remove", variant: "danger" })),
        ])]) });
  const full = settingsSection({ id: "full-check", title: "Full check", state: view.full === null ? " · None yet" : "",
    body: view.full === null
      ? joinHtml([note("Approve one from the command line:"), codeLine(`toolroll verify set --repo … --command "…"`)])
      : command(view.full) });
  return joinHtml([head, level, batchHtml(view), reviewHtml(view), quick, full]);

  /** Batch checks: one state and one sentence; turning it on restates exactly what happens before the password. */
  function batchHtml(view: CheckSettingsView): Html | "" {
    const batch = view.batch;
    if (batch === undefined) return "";
    const act = batch.on ? "Turn off" : "Turn on";
    const terms = batch.on ? note("Each result runs its own full check again. Results already waiting are checked now.")
      : list(["When results finish within 10 minutes of each other, they're merged in a temporary checkout and the full check runs once.",
          "If it fails, the batch is split until the result that breaks it is found. Results that conflict are checked on their own.",
          "Nothing is merged into a real branch. Each result still lands on its own."]);
    return settingsSection({ id: "batch-checks", title: "Batch checks", state: html`<span data-batch-checks="${batch.on ? "on" : "off"}"> · ${batch.on ? "On" : "Off"}</span>`, lead: BATCH_HINT,
      body: joinHtml([batch.on && view.level !== "full" ? note("Only Full checks are batched.") : "",
        view.canChange ? disclose(act, form("batch-form", "batch", terms, { label: act, variant: "outline" }, { on: batch.on ? "0" : "1" })) : ""]) });
  }

  /** Automatic review: one state, one sentence, and its one change behind a disclosure (the password). */
  function reviewHtml(view: CheckSettingsView): Html | "" {
    const review = view.review;
    if (review === undefined) return "";
    const state = review.on ? (review.source === "hands-off" ? "On while hands-off lasts" : "On") : "Off";
    const act = review.on ? "Turn off" : "Turn on";
    return settingsSection({ id: "automatic-review", title: "Automatic review", state: html`<span data-review-switch="${review.on ? "on" : "off"}"> · ${state}</span>`,
      lead: "One read-only review after each build passes its checks. Only high findings send it back, once.",
      body: view.canChange ? disclose(act, form("review-form", "review", html``, { label: act, variant: "outline" }, { on: review.on ? "0" : "1" })) : "" });
  }
}

/** The follow-up list's look (result-follow-ups.ts); the checks page itself is kit markup. */
export const CHECK_SETTINGS_CSS = `
  .follow-ups .follow-up-list { margin: .4rem 0; padding-left: 1.1rem; display: grid; gap: .25rem; }
  .follow-ups .follow-up-acts, .follow-ups .follow-up-act { display: flex; flex-wrap: wrap; gap: .5rem; margin: .5rem 0 0; }
  .follow-ups .follow-up-act { margin: 0; }
  .follow-ups button { min-height: 44px; }
  @media (max-width: 480px) { .follow-ups .follow-up-acts, .follow-ups .follow-up-act { display: grid; } .follow-ups .follow-up-act button { width: 100%; } }
`;
