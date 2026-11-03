/**
 * Starter flows (New flow → Starter flows): a project's starter flows, each switched on with one yes. A row says what
 * it's for, what it will do and what it never does (the whole of what the yes agrees to), then one button. A starter
 * that's on links to its flow; one that can't run here says why.
 */
import type { StarterView } from "./flow-starters.js";
import { html, postForm, type Html } from "./html.js";
import { templateRow } from "./flow-gallery-ui.js";
import { btn, chip, group, note } from "./server/kit.js";

export const STARTERS_CSS = `.fl-starter-does{margin:2px 0 0;padding-left:18px;font-size:12.5px;line-height:1.5;color:var(--so-muted)}.fl-starter-never{font-weight:500;color:var(--so-ink)}` +
  `.fl-trow[data-suggested="true"]{border-left:2px solid var(--so-ink);padding-left:12px}`;

export function startersHtml(input: {
  repo: string; projectName: string; starters: readonly StarterView[]; canSwitch: boolean; suggested: string | null;
}): Html {
  // The one asked about ("Do this every time…") comes first, marked.
  const ordered = [...input.starters].sort((a, b) => Number(b.id === input.suggested) - Number(a.id === input.suggested));
  const rows = ordered.map(one => {
    const action = one.on !== null ? btn("Open flow", { sm: true, href: `/flows/${one.on.flow}` })
      : one.blocked !== null || !input.canSwitch ? ""
      : postForm("/settings/flows/on", btn("Switch on", { sm: true, type: "submit", attrs: { "aria-label": `Switch on ${one.name}` } }), { hidden: { repo: input.repo, starter: one.id } });
    // What the yes agrees to, in full, before it; nothing to agree to once it's on or can't be.
    const line = one.on !== null ? chip("On", "done")
      : one.blocked !== null ? html`<span>${one.blocked}</span>`
      : html`<span><ul class="fl-starter-does">${one.does.map(words => html`<li>${words}</li>`)}</ul><span class="fl-starter-never">${one.never}</span></span>`;
    return templateRow({ name: one.name, promise: one.summary, line, action, attrs: html` id="starter-${one.id}" data-starter="${one.id}" data-suggested="${String(one.id === input.suggested && one.on === null)}"` });
  });
  const nobody = !input.canSwitch && input.starters.some(one => one.on === null) ? note("An approver switches these on.") : "";
  return html`${group(`Starter flows for ${input.projectName}`)}<div data-group="starters">${rows}</div>${nobody}`;
}
