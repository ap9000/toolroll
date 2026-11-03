/**
 * Settings → Approval rules (v102): a project's separation of duties. An
 * instance operator sets them (with their password, or a fresh sign-in with
 * the identity provider); everyone else reads them. Every change is in the
 * ledger, before → after.
 */
import { joinHtml, type Html } from "./html.js";
import { formRow, note, radios, settingsSection, switchInput, textarea } from "./server/kit.js";
import { kitSectionForm } from "./settings-kit.js";
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

export function releaseApprovalHtml(view: ReleaseApprovalView, notice: { said?: string | null; problem?: string | null } = {}): Html {
  const since = view.setBy === null ? "" : ` · changed by ${view.setBy} on ${(view.at ?? "").slice(0, 10)}`;
  const current = view.auto ? "Releases approve themselves once the pull request’s CI and the release check pass on the exact commit. Anything red still asks you." : "Every release waits for your approval.";
  if (!view.canChange) return settingsSection({ id: "release-approval", title: "Releases", state: since, body: joinHtml([note(current), note("An approver of this project sets this.")]) });
  return settingsSection({ id: "release-approval", title: "Releases", state: since, lead: current,
    body: kitSectionForm({ proof: "release-approval", action: "/settings/release-approval", id: "release-form", gate: true, hidden: { repo: view.repo }, proofWhen: ["action", "auto"],
      confirm: "Approve releases automatically", said: notice.said ?? null, problem: notice.problem ?? null,
      body: formRow("Releases", "Turning this on asks for your password, every time, even with Passwordless on.", radios({ name: "action", legend: "Releases", current: view.auto ? "auto" : "ask", items: [
        { value: "ask", label: "Ask me", text: "A release deploys only after you approve it." },
        { value: "auto", label: "Approve automatically when checks pass", text: "You’re told when a release approves itself. A failed check, red CI or a CI failure after the deploy still stops and asks you." }] }), "wide") }) });
}

export function approvalRulesHtml(view: ApprovalRulesView, notice: { said?: string | null; problem?: string | null }): Html {
  const changed = view.rules.updatedBy === null ? "" : ` · changed by ${view.rules.updatedBy} on ${(view.rules.updatedAt ?? "").slice(0, 10)}`;
  const current = rulesSummary(view.rules);
  if (!view.canChange) return settingsSection({ id: "rules", title: `Approval rules · ${view.name}`, state: changed, body: joinHtml([note(current), note("An instance operator sets these.")]) });
  const protect = view.rules.protectProject ? "project" : view.rules.protectedPaths.length > 0 ? "paths" : "none";
  const few = view.approvers < 2 ? note(`Only ${view.approvers === 1 ? "one person" : "no one"} can approve on this project, so protected work would wait for a second approver. Add one in People first.`) : "";
  return settingsSection({ id: "rules", title: `Approval rules · ${view.name}`, state: changed, lead: current,
    body: kitSectionForm({ proof: "approval", action: "/settings/approval", id: "rules-form", gate: true, hidden: { repo: view.repo }, confirm: "Change approval rules",
      said: notice.said ?? null, problem: notice.problem ?? null,
      body: joinHtml([
        formRow("Someone other than the requester", "The person who filed a task, or asked for a revision, can’t approve it. Operating modes stop approving their signer’s own filings here.",
          switchInput({ id: "rules-not-requester", name: "not_requester", label: "Required", on: view.rules.notRequester, attrs: { value: "1", "aria-label": "Someone other than the requester" } }), "inline"),
        formRow("Protected work", "Changes here always wait for two people, never a subagent or an operating mode.", radios({ name: "protect", legend: "Protected work", current: protect, items: [
          { value: "none", label: "Nothing protected", text: "One approval is enough." },
          { value: "project", label: "The whole project", text: "Every task needs two different people to approve the same scope." },
          { value: "paths", label: "Only these paths", text: "Tasks that touch them, or don’t say what they touch, need two people." }] }), "wide"),
        formRow("Protected paths", "One per line. Used when “Only these paths” is chosen.", textarea({ id: "rules-paths", name: "paths", value: view.rules.protectedPaths.join("\n"), rows: 3, attrs: { spellcheck: "false", placeholder: "infra/**\nmigrations/**", "aria-label": "Protected paths" } }), "top"),
        few,
      ]) }) });
}
