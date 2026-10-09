/**
 * Settings → Approval rules (v102): a project's separation of duties. An
 * instance operator sets them (with their password, or a fresh sign-in with
 * the identity provider); everyone else reads them. Every change is in the
 * ledger, before → after.
 */
import type { ApprovalRules } from "./approval-policy.js";

const e = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export const APPROVAL_RULES_CSS = `.approval-rules{max-width:720px;min-width:0}.approval-rules fieldset{border:0;padding:0;margin:18px 0 0;min-width:0}` +
  `.approval-rules legend{font-weight:600;font-size:.875rem;margin-bottom:8px}.approval-rules .choice{display:grid;grid-template-columns:auto minmax(0,1fr);gap:10px;align-items:start;margin:0 0 10px;font-weight:400}` +
  `.approval-rules .choice input{margin:.2rem 0 0}.approval-rules .choice strong{display:block;font-size:.875rem;font-weight:500}.approval-rules .choice small{display:block;color:var(--muted-foreground);font-size:.8125rem;margin-top:2px}` +
  `.approval-rules textarea{min-height:88px;font-family:var(--font-mono);font-size:.8125rem}.approval-rules .paths{margin:4px 0 0 26px}` +
  `.approval-rules .current{margin:0 0 4px}.approval-rules .step-up{margin-top:16px}.approval-rules button[type=submit]{margin-top:14px}`;

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

export function approvalRulesHtml(view: ApprovalRulesView, csrf: string, notice: { said?: string | null; problem?: string | null }): string {
  const note = notice.problem ? `<p class="problem" role="alert">${e(notice.problem)}</p>` : notice.said ? `<p role="status">${e(notice.said)}</p>` : "";
  const changed = view.rules.updatedBy === null ? "" : ` <span class="meta">Changed by ${e(view.rules.updatedBy)} on ${e((view.rules.updatedAt ?? "").slice(0, 10))}.</span>`;
  const current = `<p class="current">${e(rulesSummary(view.rules))}${changed}</p>`;
  if (!view.canChange) return `<section class="approval-rules">${note}${current}<p class="meta">An instance operator sets these.</p></section>`;
  const protect = view.rules.protectProject ? "project" : view.rules.protectedPaths.length > 0 ? "paths" : "none";
  const radio = (value: string, title: string, hint: string) => `<label class="choice"><input type="radio" name="protect" value="${value}"${protect === value ? " checked" : ""}><span><strong>${title}</strong><small>${hint}</small></span></label>`;
  const few = view.approvers < 2 ? `<p class="meta">Only ${view.approvers === 1 ? "one person" : "no one"} can approve on this project, so protected work would wait for a second approver. Add one in People first.</p>` : "";
  return `<section class="approval-rules">${note}${current}` +
    `<form method="post" action="/settings/approval"><input type="hidden" name="csrf" value="${e(csrf)}"><input type="hidden" name="repo" value="${e(view.repo)}">` +
    `<fieldset><legend>Who approves</legend><label class="choice"><input type="checkbox" name="not_requester" value="1"${view.rules.notRequester ? " checked" : ""}>` +
    `<span><strong>Someone other than the requester</strong><small>The person who filed a task, or asked for a revision, can't approve it. Operating modes stop approving their signer's own filings here.</small></span></label></fieldset>` +
    `<fieldset><legend>Protected work</legend>` +
    radio("none", "Nothing protected", "One approval is enough.") +
    radio("project", "The whole project", "Every task needs two different people to approve the same scope.") +
    radio("paths", "Only these paths", "Tasks that touch them, or don't say what they touch, need two people.") +
    `<div class="paths"><label>Protected paths, one per line<textarea name="paths" spellcheck="false" placeholder="infra/**&#10;migrations/**">${e(view.rules.protectedPaths.join("\n"))}</textarea></label></div>` +
    few + `</fieldset>` +
    `<div class="step-up"><label>Your Toolroll password<input type="password" name="password" autocomplete="current-password"></label></div>` +
    `<button type="submit">Save rules</button></form></section>`;
}
