/**
 * Starter kits: the "With an agent" rows of New flow (each kit's promise, what it sets up, one button to its page)
 * and a kit's own page, a reading page: what it sets up, then its checklist with the next step on each line
 * (connect email, connect a tool, try a sample card).
 */
import type { Store } from "./store.js";
import { kitChecklist, kitInstalled, KITS, type Kit } from "./kits.js";
import { SUBAGENT_TEMPLATES } from "./subagents.js";
import { html, postForm, reauth, type Html } from "./html.js";
import { templateRow } from "./flow-gallery-ui.js";
import { acts, btn, count, doc, docHeader, dock, facts, group, icon, infoLine, input, note, notice, phoneHeader } from "./server/kit.js";

export const KITS_CSS = `.fl-kit-steps{list-style:none;padding:0;margin:0;display:grid;border-top:1px solid var(--so-line)}` +
  `.fl-kit-steps li{display:flex;align-items:center;gap:12px;min-height:48px;padding:8px 0;border-bottom:1px solid var(--so-line);min-width:0}` +
  `.fl-kit-steps li>.k-i{flex:none;color:var(--so-muted)}.fl-kit-steps li[data-done="true"]>.k-i{color:var(--so-done-ink)}.fl-kit-ring{flex:none;width:14px;height:14px;margin:0 1px;border:1.5px solid var(--so-field-line);border-radius:50%;box-sizing:border-box}` +
  `.fl-kit-said{flex:1;min-width:0;font-size:13px;overflow-wrap:anywhere}.fl-kit-steps li[data-done="true"] .fl-kit-said{color:var(--so-muted)}.fl-kit-steps form{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:0}.fl-kit-steps .k-input{width:180px}` +
  `@media(max-width:760px){.fl-kit-steps li{flex-wrap:wrap}.fl-kit-said{flex-basis:calc(100% - 40px)}.fl-kit-steps form,.fl-kit-steps .k-input{width:100%}}`;

const subagentWords = (kit: Kit) => { const template = SUBAGENT_TEMPLATES.find(one => one.id === kit.subagent.template); return template === undefined ? kit.subagent.handle : template.label.toLowerCase(); };
const agentName = (kit: Kit) => kit.subagent.handle.charAt(0).toUpperCase() + kit.subagent.handle.slice(1);
const kitHref = (kit: Kit, repo: string) => `/kits/${kit.id}?repo=${encodeURIComponent(repo)}`;

/** "With an agent": every kit as a row; Set it up (or Open, once it's there) goes to the kit's page for `repo`. */
export function kitRowsHtml(store: Store, repo: string | null): Html {
  const rows = KITS.map(kit => {
    const here = repo !== null && kitInstalled(store, kit, repo) !== null;
    const gets = `${agentName(kit)} (${subagentWords(kit)}) and the ${kit.flowName} flow${kit.tools.length === 0 ? "" : ` · works with ${kit.tools.map(one => one.label).join(" and ")}`}`;
    return templateRow({ name: kit.name, promise: kit.promise, line: gets, attrs: html` data-kit="${kit.id}"`,
      action: repo === null ? "" : btn(here ? "Open" : "Set it up", { sm: true, href: kitHref(kit, repo), attrs: { "aria-label": `${here ? "Open" : "Set up"} ${kit.name}` } }) });
  });
  return html`${group("With an agent", count(KITS.length))}<div data-group="kits">${rows}</div>`;
}

/** A kit's own page: what it sets up, Set up (once), then the next step on each line. */
export function kitPageHtml(store: Store, kit: Kit, repo: string, dir: string | null, canSetUp: boolean, notice_: { said?: string | null; problem?: string | null }, projectName: (repo: string) => string = one => one): Html {
  const steps = kitChecklist(store, kit, repo, dir);
  const set = kitInstalled(store, kit, repo);
  const back = `/flows/new?group=kits&repo=${encodeURIComponent(repo)}`;
  const rows = steps.map(step => {
    const go = step.done ? (step.href === null ? "" : btn("Open", { sm: true, href: step.href }))
      : step.action === "sample" || step.action === "github"
        ? (canSetUp ? postForm(`/kits/${kit.id}/${step.action}`, step.action === "sample" ? btn("Try it", { sm: true, type: "submit" })
          // Issues from anyone come in: it takes your password (an ordinary step-up; a session does under Passwordless).
          : html`${reauth(input({ id: `fl-kit-${step.id}-password`, name: "password", type: "password", attrs: { autocomplete: "current-password", "aria-label": "Your password", placeholder: "Your password" } }))}${btn("Bring them in", { sm: true, type: "submit" })}`, { hidden: { repo } }) : "")
        : step.href === null ? "" : btn(step.action === "connect" ? "Connect" : "Set up", { sm: true, href: step.href });
    return html`<li data-step="${step.id}" data-done="${String(step.done)}">${step.done ? icon("check", true) : html`<span class="fl-kit-ring" aria-hidden="true"></span>`}<span class="fl-kit-said">${step.said}</span>${go}</li>`;
  });
  const setUp = set === null && canSetUp ? postForm(`/kits/${kit.id}/setup`, acts(btn(`Set up ${kit.name}`, { variant: "primary", type: "submit", docked: true })), { hidden: { repo }, attrs: { id: "fl-kit-setup" } }) : "";
  const about = facts([["Project", projectName(repo)], ["Agent", `${agentName(kit)} (${subagentWords(kit)})`], ["Flow", kit.flowName], ...(kit.tools.length === 0 ? [] : [["Works with", kit.tools.map(one => one.label).join(" and ")] as const])]);
  return html`<div class="fl-kit" data-kit-page data-kit="${kit.id}">${phoneHeader(kit.name, { back })}${doc(
    docHeader({ title: kit.name, back: [back, "New flow"], meta: kit.promise, same: true }),
    notice_.problem ? notice(notice_.problem) : "", notice_.said ? infoLine(notice_.said) : "",
    about, set === null ? note("Nothing goes out without you approving it.") : "", setUp,
    rows.length === 0 ? "" : html`<section class="k-sec" aria-labelledby="fl-kit-next"><h3 id="fl-kit-next">Next steps</h3><ol class="fl-kit-steps">${rows}</ol></section>`)}\
${set === null && canSetUp ? dock(btn(`Set up ${kit.name}`, { variant: "primary", type: "submit", attrs: { form: "fl-kit-setup" } })) : ""}</div>`;
}
