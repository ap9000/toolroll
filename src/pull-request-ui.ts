/** Settings → Projects → Pull requests: one project's pull-request setup, in plain words. Off shows what setup
 * found (or what to fix) and one Turn on; on shows where pull requests go and how they merge. Every change takes
 * the password; turning on restates the exact repository and branch that were checked. */
import { html, joinHtml, postForm, type Html } from "./html.js";
import type { MergeMethod, Publishing, PublishingPlan } from "./pull-request-flow.js";
import { acts, btn, disclose, formRow, infoLine, note, notice, select, settingsSection, switchInput } from "./server/kit.js";
import { kitSectionForm } from "./settings-kit.js";


export type PullRequestSettingsView = {
  repo: string;
  name: string;
  csrf: string;
  canChange: boolean;
  publishing: Publishing;
  /** When off: what setup found — the plan to confirm, or what to fix first. */
  check: { ok: true; plan: PublishingPlan } | { ok: false; message: string } | "unchecked" | null;
  said: string | null;
  problem: string | null;
};

const METHOD_WORDS: Record<MergeMethod, string> = { squash: "Squash and merge", merge: "Merge commit", rebase: "Rebase and merge" };
const mono = (text: string): Html => html`<span class="k-mono">${text}</span>`;

export function pullRequestSettingsHtml(view: PullRequestSettingsView): Html {
  const head = joinHtml([
    view.problem === null ? "" : notice(view.problem),
    view.said === null ? "" : infoLine(view.said),
    note(html`${view.name} · ${mono(view.repo)}`),
  ]);
  const publishing = view.publishing;
  if (publishing.on) {
    const status = settingsSection({ id: "pull-requests", title: "Pull requests", state: " · On",
      lead: html`${mono(publishing.githubRepo)} into ${mono(publishing.base)}`,
      body: note(`${publishing.legacy ? "Every finished build opens a pull request (set up with publish grant)." : "Complete offers “Complete and open a pull request”."} Set up by ${publishing.grantedBy}.`) });
    if (!view.canChange) return joinHtml([head, status]);
    const merging = settingsSection({ id: "merging", title: "Merging",
      body: kitSectionForm({ proof: "pull-requests", action: "/settings/pull-requests", id: "merging-form", gate: true, hidden: { repo: view.repo, act: "settings" },
        body: joinHtml([
          formRow("Merge method", null, select({ id: "pr-method", name: "method", label: "Merge method", current: publishing.mergeMethod,
            items: (["squash", "merge", "rebase"] as const).map(method => [method, `${METHOD_WORDS[method]}${method === "squash" ? " (default)" : ""}`] as const) })),
          formRow("Merge when checks pass", "Off by default. When on, a pull request merges by itself once its checks pass on the completed commit. Branches are deleted after merging.",
            switchInput({ id: "pr-when-green", name: "when-green", label: publishing.mergeWhenGreen ? "On" : "Off", on: publishing.mergeWhenGreen, attrs: { value: "1", "aria-label": "Merge when checks pass" } }), "inline"),
        ]) }) });
    const off = disclose("Turn off pull requests", kitSectionForm({ proof: "pull-requests", action: "/settings/pull-requests", id: "pr-off-form", hidden: { repo: view.repo, act: "off" },
      save: { label: "Turn off", variant: "danger" }, confirm: "Turn off pull requests", body: note("Nothing more is pushed. Open pull requests stay on GitHub.") }));
    return joinHtml([head, status, merging, off]);
  }
  const check = view.check;
  if (check === null) return joinHtml([head, settingsSection({ id: "pull-requests", title: "Pull requests", state: " · Off", body: note("An approver can turn on pull requests.") })]);
  // The checks ask git and GitHub, so they run when asked, never on opening the page (docs/plans/get-side-effects.md).
  const checkButton = (label: string, variant: "primary" | "outline") =>
    postForm("/settings/pull-requests/check", acts(btn(label, { sm: true, type: "submit", variant })), { hidden: { repo: view.repo } });
  if (check === "unchecked") {
    return joinHtml([head, settingsSection({ id: "pull-requests", title: "Pull requests", state: " · Off",
      lead: "Check this project's GitHub setup to see what turning on would do.", body: checkButton("Check setup", "primary") })]);
  }
  if (!check.ok) {
    return joinHtml([head, settingsSection({ id: "pull-requests", title: "Pull requests", state: " · Can’t turn on yet",
      body: joinHtml([notice(check.message), checkButton("Check again", "outline")]) })]);
  }
  const plan = check.plan;
  return joinHtml([head, settingsSection({ id: "pull-requests", title: "Pull requests", state: " · Ready to turn on",
    body: kitSectionForm({ proof: "pull-requests-on", action: "/settings/pull-requests", id: "pr-on-form", hidden: { repo: view.repo, act: "on", github: plan.githubRepo, base: plan.base },
      save: { label: "Turn on pull requests" }, confirm: "Turn on pull requests",
      body: html`<ul class="k-note"><li>Pull requests open on ${mono(plan.githubRepo)} into ${mono(plan.base)}${plan.account === null ? "" : `, as ${plan.account}`}.</li>\
<li>Complete offers “Complete and open a pull request”, from the exact completed commit. A flow's Pull request zone can open one too.</li>\
<li>Merging squashes and deletes the branch. A person merges with their password; a flow merges only when its zone says so, after a person approved the card.</li></ul>` }) })]);
}

/** Kept for the console's style bundle (server/chrome.ts); the page itself is kit markup. */
export const PULL_REQUEST_SETTINGS_CSS = "";
