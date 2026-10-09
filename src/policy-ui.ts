/**
 * Settings → Policy (sprint 8): the organisation policy — allowed providers,
 * models and tools, and the permission ceiling — and its history from the
 * action ledger. Anyone signed in reads it; an instance operator changes it
 * with their password.
 */
import { html, postForm, type Html } from "./html.js";
import type { LedgerEntry } from "./action-ledger.js";
import { whenUtc } from "./when-html.js";
import { LEVEL_HINTS, LEVEL_NAMES, PERMISSION_LEVELS, POLICY_PROVIDERS, PROVIDER_NAMES, policyParts, type SavedPolicy } from "./policy.js";


export const POLICY_CSS = `.policy{max-width:720px;min-width:0}.policy dl{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:6px 16px;margin:12px 0 0;font-size:.875rem}` +
  `.policy dt{color:var(--muted-foreground)}.policy dd{margin:0;overflow-wrap:anywhere}.policy fieldset{border:0;padding:0;margin:20px 0 0;min-width:0}` +
  `.policy legend{font-weight:600;font-size:.875rem;margin-bottom:8px}.policy legend{padding:0}.policy .providers{display:grid;grid-template-columns:repeat(auto-fill,minmax(132px,1fr));gap:0 16px}.policy .providers label{display:flex;gap:8px;align-items:center;min-height:44px;margin:0;padding:0;font-weight:400}` +
  `.policy .choice{display:grid;grid-template-columns:auto minmax(0,1fr);gap:10px;align-items:start;margin:0 0 10px;font-weight:400}.policy .choice input{margin:.2rem 0 0}` +
  `.policy .choice strong{display:block;font-size:.875rem;font-weight:500}.policy .choice small,.policy .hint{display:block;color:var(--muted-foreground);font-size:.8125rem;margin-top:2px}` +
  `.policy textarea{width:100%;min-height:72px;font-family:var(--font-mono);font-size:.8125rem;box-sizing:border-box}.policy .step-up{margin-top:18px}.policy button[type=submit]{margin-top:14px}` +
  `.policy details{margin-top:28px}.policy summary{cursor:pointer;min-height:44px;display:flex;align-items:center;font-weight:600;font-size:.875rem}` +
  `.policy ol{list-style:none;padding:0;margin:0}.policy li{padding:10px 0;border-bottom:1px solid var(--border);font-size:.8125rem;overflow-wrap:anywhere}.policy li .what{display:block;font-size:.875rem}`;

export type PolicyView = {
  policy: SavedPolicy;
  history: LedgerEntry[];
  canChange: boolean;
  /** The project tools here, as a hint for the tools list. */
  toolNames: string[];
};

/** A ledger entry as one line of history: when, who, what, before → after. */
function historyItem(entry: LedgerEntry): Html {
  const what = entry.action.replace(/^organisation policy: /, "");
  const [before, after] = (entry.detail ?? "").split(" → ");
  return html`<li><span class="what">${what.charAt(0).toUpperCase() + what.slice(1)}: ${before ?? ""} → <strong>${after ?? ""}</strong></span><span class="meta">${entry.actor} · ${whenUtc(entry.at)}</span></li>`;
}

export function policyHtml(view: PolicyView, notice: { said?: string | null; problem?: string | null }): Html {
  const note = notice.problem ? html`<p class="problem" role="alert">${notice.problem}</p>` : notice.said ? html`<p role="status">${notice.said}</p>` : "";
  const parts = policyParts(view.policy);
  const changed = view.policy.updatedBy === null ? "" : html`<p class="meta">Changed by ${view.policy.updatedBy} on ${(view.policy.updatedAt ?? "").slice(0, 10)}.</p>`;
  const current = html`<dl><dt>Providers</dt><dd>${parts.providers === "any" ? "Any" : parts.providers}</dd><dt>Models</dt><dd>${parts.models === "any" ? "Any" : parts.models}</dd><dt>Tools</dt><dd>${parts.tools === "any" ? "Any" : parts.tools}</dd><dt>Ceiling</dt><dd>${parts.ceiling}</dd></dl>${changed}`;
  const history = view.history.length === 0 ? "" : html`<details><summary>History (${view.history.length})</summary><ol>${view.history.map(historyItem)}</ol></details>`;
  if (!view.canChange) return html`<section class="policy">${note}${current}<p class="meta">An instance operator sets the policy.</p>${history}</section>`;
  const providers = POLICY_PROVIDERS.map(one => html`<label><input type="checkbox" name="provider" value="${one}"${view.policy.providers === null || view.policy.providers.includes(one) ? html` checked` : ""}> ${PROVIDER_NAMES[one]}</label>`);
  const levels = [...PERMISSION_LEVELS].reverse().map(level => html`<label class="choice"><input type="radio" name="ceiling" value="${level}"${view.policy.ceiling === level ? html` checked` : ""}><span><strong>${LEVEL_NAMES[level]}</strong><small>${LEVEL_HINTS[level]}</small></span></label>`);
  const toolHint = view.toolNames.length === 0 ? "" : ` Tools here: ${view.toolNames.slice(0, 12).join(", ")}${view.toolNames.length > 12 ? "…" : ""}.`;
  return html`<section class="policy">${note}${changed}${postForm("/settings/policy", html`<fieldset><legend>Providers</legend><div class="providers">${providers}</div></fieldset><fieldset><legend><label for="policy-models">Models</label></legend><textarea id="policy-models" name="models" spellcheck="false" placeholder="Any model" aria-describedby="policy-models-hint">${(view.policy.models ?? []).join("\n")}</textarea><span class="hint" id="policy-models-hint">One per line; end with * to allow a family. Blank allows any.</span></fieldset><fieldset><legend><label for="policy-tools">Project tools</label></legend><textarea id="policy-tools" name="tools" spellcheck="false" placeholder="Any tool" aria-describedby="policy-tools-hint">${(view.policy.tools ?? []).join("\n")}</textarea><span class="hint" id="policy-tools-hint">One per line. Blank allows any.${toolHint}</span></fieldset><fieldset><legend>Permission ceiling</legend>${levels}</fieldset><div class="step-up"><label>Your Toolroll password<input type="password" name="password" autocomplete="current-password" required></label></div><button type="submit">Save policy</button>`)}${history}</section>`;
}
