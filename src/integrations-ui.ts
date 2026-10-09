/**
 * Settings → Integrations: which integrations work. One row each: its name
 * and state, the account it's connected as, when it last worked and last
 * failed, what uses it, and one action. The list comes from saved checks; a
 * render never waits on one (see integrations.ts).
 */
import { html, joinHtml, postForm, type Html } from "./html.js";
import { STATE_WORDS, type Integration, type IntegrationGroup } from "./integrations.js";
import { whenUtc } from "./when-html.js";
import { brandMarkHtml } from "./brand-mark.js";

const when = (at: string) => whenUtc(at);

export const INTEGRATIONS_CSS = `.integrations{max-width:760px;min-width:0}.integrations h2{margin:24px 0 6px;font-size:.9375rem}` +
  `.integrations .integration{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px 16px;align-items:start;padding:12px 0;border-top:1px solid var(--so-line);min-width:0}` +
  `.integrations .integration>:not(.integration-action),.integrations .integration-body>*{grid-column:1}.integrations .integration-body{display:contents}.integrations .integration:first-of-type{border-top:0}.integrations .integration-head{margin:0;display:flex;flex-wrap:wrap;gap:6px 10px;align-items:center;min-width:0}` +
  `.integrations .integration .integration-body>*{margin-left:calc(var(--brand-mark) + 10px)}.integrations .integration-head strong{overflow-wrap:anywhere}.integrations .integration p{margin:2px 0 0;min-width:0;overflow-wrap:anywhere}` +
  `.integrations .integration-action{grid-column:2;grid-row:1 / span 3;align-self:center;margin:0}.integrations .integration-action button,.integrations .integration-action .button-link{min-height:44px;white-space:nowrap}` +
  `.integrations .integration .integration-action button{width:auto}.integrations .integration .integration-action a.integration-quiet{background:var(--so-paper);color:var(--so-ink);border:1px solid var(--so-input-line)}` +
  `.integrations .integration-fix{color:var(--so-danger)}.integrations code{overflow-wrap:anywhere}.integrations details{margin-top:4px;font-size:.8125rem}.integrations summary{cursor:pointer;padding:4px 0}` +
  `.integration-state{display:inline-flex;align-items:center;gap:6px;font-size:.75rem;font-weight:500;padding:0 8px;border-radius:5px;line-height:20px;white-space:nowrap}` +
  `.integration-state i{width:6px;height:6px;border-radius:50%;background:currentColor}` +
  `.integration-state--connected{color:var(--so-success);background:var(--so-success-soft)}.integration-state--broken{color:var(--so-danger);background:var(--so-danger-soft)}` +
  `.integration-state--not-set-up,.integration-state--checking{color:var(--so-muted);background:var(--so-neutral-soft)}` +
  // A phone: the action sits at the right of the name line, and the facts under it run on as one line.
  `@media (max-width:760px){.integrations h2{margin:16px 0 0}.integrations .integration{gap:0 12px;padding:6px 0 8px}.integrations .integration-head{min-height:44px}` +
  `.integrations .integration-action{grid-row:1;align-self:center}.integrations .integration-body{display:block;grid-column:1 / -1;line-height:1.35;padding-left:calc(var(--brand-mark) + 10px)}.integrations .integration .integration-body>*{margin-left:0}` +
  `.integrations .integration-body>p{margin:0}.integrations .integration-body>p.meta{display:inline}.integrations .integration-body>p.meta+p.meta::before{content:" · "}` +
  `.integrations .integration-body>:not(.meta){margin-top:4px}.integrations .integration-body>:not(.meta)+p.meta{display:block;margin-top:2px}.integrations details{margin-top:2px}}`;

const GROUPS: [IntegrationGroup, string][] = [
  ["chat", "Chat"], ["code", "Code and issues"], ["mail", "Email"], ["tools", "MCP tools"], ["monitoring", "Monitoring"], ["agents", "Agents"],
];

function action(one: Integration, csrf: string): Html | "" {
  const a = one.action;
  if (a.kind === "test") {
    return csrf === "" ? "" : postForm("/settings/integrations/test", html`<button type="submit">Send test</button>`, { attrs: { class: "integration-action" }, hidden: { key: one.key } });
  }
  // A command is run where Toolroll runs; a page is linked. Fix and Set up both say which.
  // Fix is the one filled action on the page; Set up stays quiet so a list of unused services doesn't shout.
  if (a.href !== null) return html`<p class="integration-action"><a class="button-link${a.kind === "setup" ? " integration-quiet" : ""}" href="${a.href}">${a.label}</a></p>`;
  return "";
}

/** Which mark a row shows: email is Gmail's only when the account is a Gmail address; a custom tool is a letter. */
function markFor(one: Integration): string | null {
  if (one.custom) return null;
  return one.key === "email" && /@(gmail|googlemail)\.com$/i.test(one.account ?? "") ? "gmail" : one.key;
}

function row(one: Integration, csrf: string): Html {
  const badge = !one.checked && one.state === "connected"
    ? html`<span class="integration-state integration-state--checking"><i aria-hidden="true"></i>Checking</span>`
    : html`<span class="integration-state integration-state--${one.state}"><i aria-hidden="true"></i>${STATE_WORDS[one.state]}</span>`;
  const facts = [one.account, one.detail].filter(Boolean).join(" · ");
  const command = one.action.kind !== "test" ? one.action.command : null;
  const fix = one.action.kind === "fix" ? html`<p class="integration-fix" role="status">${one.action.words}</p>` : "";
  const run = command === null || (one.action.kind === "fix" && one.action.words.includes(command)) ? "" : html`<p class="meta">Run <code>${command}</code> on the computer running Toolroll.</p>`;
  const seen = [one.lastSuccessAt === null ? null : html`Last success ${when(one.lastSuccessAt)}`, one.usedBy.length === 0 ? null : html`Used by ${one.usedBy.join(", ")}`].filter(Boolean);
  const history = one.state === "not-set-up" || seen.length === 0 ? "" : html`<p class="meta">${joinHtml(seen, " · ")}</p>`;
  const lastError = one.lastError === null || one.state === "not-set-up" ? "" : one.state === "broken" && one.action.kind === "fix" && one.action.words === one.lastError
    ? html`<p class="meta">Failed ${when(one.lastErrorAt ?? "")}</p>`
    : html`<details><summary>Last error ${one.lastErrorAt === null ? "" : when(one.lastErrorAt)}</summary><p class="meta">${one.lastError}</p></details>`;
  return html`<div class="integration" data-integration="${one.key}" data-state="${one.state}"><p class="integration-head">${brandMarkHtml(markFor(one), one.name, one.state === "connected")}<strong>${one.name}</strong> ${badge}</p>${
    action(one, csrf)}<div class="integration-body">${facts === "" ? "" : html`<p class="meta">${facts}</p>`}${fix}${run}${history}${lastError}</div></div>`;
}

export function integrationsHtml(list: readonly Integration[], csrf: string, notice: { said?: string | null; problem?: string | null; checking?: boolean }): Html {
  const note = notice.problem ? html`<p class="problem" role="alert">${notice.problem}</p>` : notice.said ? html`<p role="status">${notice.said}</p>` : "";
  const broken = list.filter(one => one.state === "broken").length;
  const summary = broken > 0 ? html`<p><strong>${broken} need${broken === 1 ? "s" : ""} fixing.</strong></p>`
    : notice.checking || list.some(one => !one.checked) ? html`<p class="meta" role="status">Checking in the background. Refresh in a few seconds.</p>` : "";
  const sections = GROUPS.map(([group, title]) => {
    const rows = list.filter(one => one.group === group);
    return rows.length === 0 ? "" : html`<h2>${title}</h2>${rows.map(one => row(one, csrf))}`;
  });
  return html`<section class="integrations">${note}${summary}${sections}</section>`;
}
