/**
 * Settings → Approval rules (v102): a project's separation of duties. An
 * instance operator sets them (with their password, or a fresh sign-in with
 * the identity provider); everyone else reads them. Every change is in the
 * ledger, before → after.
 */
import { html, postForm, type Html, reauth } from "./html.js";
import type { ApprovalRules } from "./approval-policy.js";


const RULES_CSS = `.approval-rules{max-width:720px;min-width:0}.approval-rules fieldset{border:0;padding:0;margin:18px 0 0;min-width:0}` +
  `.approval-rules legend{font-weight:600;font-size:.875rem;margin-bottom:8px}.approval-rules .choice{display:grid;grid-template-columns:auto minmax(0,1fr);gap:10px;align-items:start;margin:0 0 10px;font-weight:400}` +
  `.approval-rules .choice input{margin:.2rem 0 0}.approval-rules .choice strong{display:block;font-size:.875rem;font-weight:500}.approval-rules .choice small{display:block;color:var(--muted-foreground);font-size:.8125rem;margin-top:2px}` +
  `.approval-rules textarea{min-height:88px;font-family:var(--font-mono);font-size:.8125rem}.approval-rules .paths{margin:4px 0 0 26px}` +
  `.approval-rules .current{margin:0 0 4px}.approval-rules .step-up{margin-top:16px}.approval-rules button[type=submit]{margin-top:14px}`;
/** The rules' style, and the same for the Releases section under its own class (so a page holds one `.approval-rules`
 * form, not two). */
export const APPROVAL_RULES_CSS = RULES_CSS + RULES_CSS.replaceAll(".approval-rules", ".release-approval");

export type ApprovalRulesView = {
  repo: string;
  name: string;
  rules: ApprovalRules & { updatedBy: string | null; updatedAt: string | null };
  canChange: boolean;
  /** People who can approve on this project (two approvers need two). */
  approvers: number;
};

/** The rules in plain words, for anyone who can see the project. */
export function rulesSummary(rules: ApprovalRules): string {
  const parts: string[] = [];
  if (rules.notRequester) parts.push("The person who filed a task can't approve it.");
  if (rules.protectProject) parts.push("All work here is protected: two people approve it, never a subagent or an operating mode.");
  else if (rules.protectedPaths.length > 0) parts.push(`Work touching ${rules.protectedPaths.join(", ")} is protected: two people approve it, never a subagent or an operating mode.`);
  return parts.length === 0 ? "No approval rules: anyone who can approve on this project can approve its work, including their own." : parts.join(" ");
}

/** Settings → Approval rules → Releases (docs/plans/auto-approve-green.md): who approves this project's releases. */
export type ReleaseApprovalView = { repo: string; auto: boolean; setBy: string | null; at: string | null; canChange: boolean };

export function releaseApprovalHtml(view: ReleaseApprovalView): Html {
  const since = view.setBy === null ? "" : html` <span class="meta">Changed by ${view.setBy} on ${(view.at ?? "").slice(0, 10)}.</span>`;
  const current = html`<p class="current">${view.auto ? "Releases approve themselves once the pull request's CI and the release check pass on the exact commit. Anything red still asks you." : "Every release waits for your approval."}${since}</p>`;
  const heading = html`<h2>Release approval</h2>`;
  if (!view.canChange) return html`<section class="release-approval">${heading}${current}<p class="meta">An approver of this project sets this.</p></section>`;
  const choice = (value: "ask" | "auto", title: string, hint: string) => html`<label class="choice"><input type="radio" name="action" value="${value}"${(view.auto ? "auto" : "ask") === value ? html` checked` : ""}><span><strong>${title}</strong><small>${hint}</small></span></label>`;
  return html`<section class="release-approval">${heading}${current}${postForm("/settings/release-approval", html`<fieldset aria-label="Release approval">${
    choice("ask", "Ask me", "A release deploys only after you approve it.")}${
    choice("auto", "Approve automatically when checks pass", "You're told when a release approves itself. A failed check, red CI or a CI failure after the deploy still stops and asks you.")}</fieldset><div class="step-up"><label>Your Toolroll password (to approve automatically)<input type="password" name="password" autocomplete="current-password"></label></div><button type="submit">Save</button>`, { hidden: { repo: view.repo } })}</section>`;
}

export function approvalRulesHtml(view: ApprovalRulesView, notice: { said?: string | null; problem?: string | null }): Html {
  const note = notice.problem ? html`<p class="problem" role="alert">${notice.problem}</p>` : notice.said ? html`<p role="status">${notice.said}</p>` : "";
  const changed = view.rules.updatedBy === null ? "" : html` <span class="meta">Changed by ${view.rules.updatedBy} on ${(view.rules.updatedAt ?? "").slice(0, 10)}.</span>`;
  const current = html`<p class="current">${rulesSummary(view.rules)}${changed}</p>`;
  if (!view.canChange) return html`<section class="approval-rules">${note}${current}<p class="meta">An instance operator sets these.</p></section>`;
  const protect = view.rules.protectProject ? "project" : view.rules.protectedPaths.length > 0 ? "paths" : "none";
  const radio = (value: string, title: string, hint: Html) => html`<label class="choice"><input type="radio" name="protect" value="${value}"${protect === value ? html` checked` : ""}><span><strong>${title}</strong><small>${hint}</small></span></label>`;
  const few = view.approvers < 2 ? html`<p class="meta">Only ${view.approvers === 1 ? "one person" : "no one"} can approve on this project, so protected work would wait for a second approver. Add one in People first.</p>` : "";
  return html`<section class="approval-rules">${note}${current}${postForm("/settings/approval", html`<fieldset><legend>Who approves</legend><label class="choice"><input type="checkbox" name="not_requester" value="1"${view.rules.notRequester ? html` checked` : ""}><span><strong>Someone other than the requester</strong><small>The person who filed a task, or asked for a revision, can't approve it. Operating modes stop approving their signer's own filings here.</small></span></label></fieldset><fieldset><legend>Protected work</legend>${
    radio("none", "Nothing protected", html`One approval is enough.`)}${
    radio("project", "The whole project", html`Every task needs two different people to approve the same scope.`)}${
    radio("paths", "Only these paths", html`Tasks that touch them, or don't say what they touch, need two people.`)}<div class="paths"><label>Protected paths, one per line<textarea name="paths" spellcheck="false" placeholder="infra/**&#10;migrations/**">${view.rules.protectedPaths.join("\n")}</textarea></label></div>${
    few}</fieldset><div class="step-up">${reauth(html`<label>Your Toolroll password<input type="password" name="password" autocomplete="current-password"></label>`)}</div><button type="submit">Save rules</button>`, { hidden: { repo: view.repo } })}</section>`;
}
