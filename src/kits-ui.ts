/**
 * Starter kits pages: the gallery — each kit's promise, what it sets
 * up, one button — and a kit's own page: its checklist, with the next step on
 * each line (connect email, connect a tool, try a sample card).
 */
import type { Store } from "./store.js";
import { kitChecklist, kitInstalled, KITS, type Kit } from "./kits.js";
import { SUBAGENT_TEMPLATES } from "./subagents.js";

const e = (text: string) => text.replace(/[&<>"']/g, one => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[one]!);
const hidden = (csrf: string) => `<input type="hidden" name="csrf" value="${e(csrf)}">`;
const CHECK = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>`;
const RING = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"/></svg>`;

export const KITS_CSS = `.kits{max-width:960px;min-width:0}.kits-lede{color:var(--so-muted);margin:.25rem 0 1.5rem;max-width:40rem}.kit-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:16px}` +
  `.kit{display:flex;flex-direction:column;gap:10px;padding:20px;border:1px solid var(--so-line);border-radius:12px;background:var(--so-paper)}.kit h2{font-size:1.1rem;margin:0}.kit p{margin:0}.kit .kit-promise{line-height:1.5}` +
  `.kit .kit-gets{font-size:.85rem;color:var(--so-muted);line-height:1.5}.kit form{display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end;margin-top:auto;padding-top:6px}.kit form label{display:grid;gap:4px;font-size:.85rem;flex:1 1 140px}` +
  `.kit button,.kit .kit-open{min-height:44px}.kit .kit-open{display:inline-flex;align-items:center;margin-top:auto;font-weight:600}` +
  `.kit-steps{list-style:none;padding:0;margin:1rem 0;display:grid;gap:2px;max-width:44rem}.kit-steps li{display:flex;align-items:center;gap:12px;padding:12px 14px;border:1px solid var(--so-line);border-radius:10px;background:var(--so-paper)}` +
  `.kit-steps svg{flex:none;width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round}.kit-steps li[data-done="true"] svg{color:var(--so-success)}.kit-steps li[data-done="false"] svg{color:var(--so-muted)}` +
  `.kit-steps .kit-step-said{flex:1;min-width:0}.kit-steps li[data-done="true"] .kit-step-said{color:var(--so-muted)}.kit-steps form{margin:0}.kit-steps button,.kit-steps .kit-step-go{min-height:40px;white-space:nowrap}` +
  `.kit-steps .kit-step-go{display:inline-flex;align-items:center;padding:0 12px;border:1px solid var(--so-line);border-radius:8px;text-decoration:none;font-size:.9rem}` +
  `@media(max-width:600px){.kit-steps li{flex-wrap:wrap}.kit-steps .kit-step-said{flex-basis:calc(100% - 40px)}.kit form select{font-size:16px}}`;

const subagentWords = (kit: Kit) => { const template = SUBAGENT_TEMPLATES.find(one => one.id === kit.subagent.template); return template === undefined ? kit.subagent.handle : template.label.toLowerCase(); };

/** The gallery: every kit, set up in a project with one button (or opened, when it's already there). */
export function kitsGalleryHtml(store: Store, projects: readonly string[], projectName: (repo: string) => string, csrf: string, canSetUp: boolean, notice: { problem?: string | null }): string {
  const cards = KITS.map(kit => {
    const here = projects.filter(repo => kitInstalled(store, kit, repo) !== null);
    const open = projects.length === 1 && here.length === 1;
    const name = kit.subagent.handle.charAt(0).toUpperCase() + kit.subagent.handle.slice(1);
    const gets = `${name} (${subagentWords(kit)}) · the ${kit.flowName} flow${kit.tools.length === 0 ? "" : ` · works with ${kit.tools.map(one => one.label).join(" and ")}`}`;
    const action = open ? `<a class="kit-open" href="/kits/${kit.id}?repo=${encodeURIComponent(projects[0]!)}">Open ${e(kit.name)} →</a>`
      : !canSetUp || projects.length === 0 ? ""
      : `<form method="post" action="/kits/${kit.id}/setup">${hidden(csrf)}${projects.length === 1 ? `<input type="hidden" name="repo" value="${e(projects[0]!)}">`
        : `<label>Project<select name="repo">${projects.map(repo => `<option value="${e(repo)}">${e(projectName(repo))}${here.includes(repo) ? " (set up)" : ""}</option>`).join("")}</select></label>`}<button>Set it up</button></form>`;
    return `<article class="kit" data-kit="${kit.id}"><h2>${e(kit.name)}</h2><p class="kit-promise">${e(kit.promise)}</p><p class="kit-gets">${e(gets)}</p>${action}</article>`;
  }).join("");
  return `<section class="kits">${notice.problem ? `<p class="problem" role="alert">${e(notice.problem)}</p>` : ""}<p class="kits-lede">A working setup in one click: a subagent, the flow it works, and what to connect next. Nothing goes out without you approving it.</p><div class="kit-grid">${cards}</div></section>`;
}

/** A kit's own page: what's set up, and the next step on each line. */
export function kitPageHtml(store: Store, kit: Kit, repo: string, dir: string | null, csrf: string, canSetUp: boolean, notice: { said?: string | null; problem?: string | null }): string {
  const steps = kitChecklist(store, kit, repo, dir);
  const set = kitInstalled(store, kit, repo);
  const rows = steps.map(step => {
    const go = step.done ? (step.href === null ? "" : `<a class="kit-step-go" href="${e(step.href)}">Open</a>`)
      : step.action === "sample" || step.action === "github"
        ? (canSetUp ? `<form method="post" action="/kits/${kit.id}/${step.action}">${hidden(csrf)}<input type="hidden" name="repo" value="${e(repo)}"><button${step.action === "sample" ? "" : ' class="secondary"'}>${step.action === "sample" ? "Try it" : "Bring them in"}</button></form>` : "")
        : step.href === null ? "" : `<a class="kit-step-go" href="${e(step.href)}">${step.action === "connect" ? "Connect" : "Set up"}</a>`;
    return `<li data-step="${e(step.id)}" data-done="${step.done}">${step.done ? CHECK : RING}<span class="kit-step-said">${e(step.said)}</span>${go}</li>`;
  }).join("");
  const setUp = set === null && canSetUp ? `<form method="post" action="/kits/${kit.id}/setup">${hidden(csrf)}<input type="hidden" name="repo" value="${e(repo)}"><button>Set up ${e(kit.name)}</button></form>` : "";
  return `<section class="kits">${notice.problem ? `<p class="problem" role="alert">${e(notice.problem)}</p>` : ""}${notice.said ? `<p class="said" role="status">${e(notice.said)}</p>` : ""}` +
    `<p class="kits-lede">${e(kit.promise)}</p>${setUp}${rows === "" ? "" : `<ol class="kit-steps">${rows}</ol>`}<p class="meta"><a href="/kits">All starter kits</a></p></section>`;
}
