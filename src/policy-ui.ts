/**
 * Settings → Policy (sprint 8): the organisation policy — allowed providers,
 * models and tools, and the permission ceiling — and its history from the
 * action ledger. Anyone signed in reads it; an instance operator changes it
 * with their password.
 */
import { html, joinHtml, type Html } from "./html.js";
import type { LedgerEntry } from "./action-ledger.js";
import { whenUtc } from "./when-html.js";
import { LEVEL_HINTS, LEVEL_NAMES, PERMISSION_LEVELS, POLICY_PROVIDERS, PROVIDER_NAMES, policyParts, type SavedPolicy } from "./policy.js";
import { disclose, facts, formRow, infoLine, note, notice, radios, settingsRecord, settingsSection, textarea } from "./server/kit.js";
import { kitSectionForm } from "./settings-kit.js";

/** The old look; the page is built from the kit now. Kept for chrome.ts, which still concatenates it. */
export const POLICY_CSS = "";

export type PolicyView = {
  policy: SavedPolicy;
  history: LedgerEntry[];
  canChange: boolean;
  /** The project tools here, as a hint for the tools list. */
  toolNames: string[];
};

/** A ledger entry as one record of history: what, before → after; who; when. */
function historyItem(entry: LedgerEntry): Html {
  const what = entry.action.replace(/^organisation policy: /, "");
  const [before, after] = (entry.detail ?? "").split(" → ");
  return settingsRecord({ title: html`${what.charAt(0).toUpperCase() + what.slice(1)}: ${before ?? ""} → <b>${after ?? ""}</b>`, sub: entry.actor, when: whenUtc(entry.at) });
}

export function policyHtml(view: PolicyView, outcome: { said?: string | null; problem?: string | null }): Html {
  const answer = outcome.problem ? notice(outcome.problem) : outcome.said ? infoLine(outcome.said) : "";
  const parts = policyParts(view.policy);
  const changed = view.policy.updatedBy === null ? "" : ` · changed by ${view.policy.updatedBy} on ${(view.policy.updatedAt ?? "").slice(0, 10)}`;
  const history = view.history.length === 0 ? "" : settingsSection({ id: "policy-history", title: "History",
    body: disclose(`${view.history.length} ${view.history.length === 1 ? "change" : "changes"}`, joinHtml(view.history.map(historyItem))) });
  if (!view.canChange) {
    return joinHtml([answer, settingsSection({ id: "policy", title: "Organisation policy", state: changed, lead: "What every task may use, in every project.",
      body: joinHtml([facts([["Providers", parts.providers === "any" ? "Any" : parts.providers], ["Models", parts.models === "any" ? "Any" : parts.models],
        ["Tools", parts.tools === "any" ? "Any" : parts.tools], ["Ceiling", parts.ceiling]]), note("An instance operator sets the policy.")]) }), history]);
  }
  const providers = html`<div class="k-checks" role="group" aria-label="Providers">${POLICY_PROVIDERS.map(one => html`<label for="policy-provider-${one}"><input type="checkbox" id="policy-provider-${one}" name="provider" value="${one}"${view.policy.providers === null || view.policy.providers.includes(one) ? html` checked` : ""}> ${PROVIDER_NAMES[one]}</label>`)}</div>`;
  const toolHint = view.toolNames.length === 0 ? "" : ` Tools here: ${view.toolNames.slice(0, 12).join(", ")}${view.toolNames.length > 12 ? "…" : ""}.`;
  return joinHtml([answer, settingsSection({ id: "policy", title: "Organisation policy", state: changed, lead: "What every task may use, in every project.",
    body: kitSectionForm({ proof: "policy", action: "/settings/policy", id: "policy-form", gate: true, save: { label: "Save policy" }, confirm: "Change the policy",
      body: joinHtml([
        formRow("Providers", "Work runs only on the ticked ones. All of them allows any.", providers, "wide"),
        formRow("Models", "One per line; end with * to allow a family. Blank allows any.",
          textarea({ id: "policy-models", name: "models", value: (view.policy.models ?? []).join("\n"), rows: 3, attrs: { spellcheck: "false", placeholder: "Any model", "aria-label": "Models" } }), "top"),
        formRow("Project tools", `One per line. Blank allows any.${toolHint}`,
          textarea({ id: "policy-tools", name: "tools", value: (view.policy.tools ?? []).join("\n"), rows: 3, attrs: { spellcheck: "false", placeholder: "Any tool", "aria-label": "Project tools" } }), "top"),
        formRow("Permission ceiling", "The most any task may be allowed to do.", radios({ name: "ceiling", legend: "Permission ceiling", current: view.policy.ceiling,
          items: [...PERMISSION_LEVELS].reverse().map(level => ({ value: level, label: LEVEL_NAMES[level], text: LEVEL_HINTS[level] })) }), "wide"),
      ]) }) }), history]);
}
