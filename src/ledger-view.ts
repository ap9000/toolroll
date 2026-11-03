import type { LedgerEntry } from "./action-ledger.js";
import { projectName } from "./project.js";
import { exactWhenHtml } from "./when-html.js";
import { html, postForm, type Html } from "./html.js";
import { acts, btn, disclose, empty, infoLine, note, notice, pageHeader, select } from "./server/kit.js";


/** The ledger's kinds of event, as the filter names them. */
const EVENT_KINDS = [["work", "Work"], ["request", "Requests"], ["access", "Access"], ["sign-in", "Sign-ins"], ["policy", "Policy changes"]] as const;

/** v103: the chain's state in one line, and (for an instance operator) a checkpoint to copy off the machine. */
export type LedgerChainView = {
  ok: boolean; entries: number; through: number | null; head: string; unsealed: number;
  problem: { id: number | null; what: string } | null;
  /** When the whole chain was last walked. */
  checkedAt: string | null;
  latest: { through: number; hash: string; at: string } | null;
  csrf: string | null;
  /** Today (UTC, YYYY-MM-DD): the audit export's default range ends here. */
  today: string;
};
function chainHtml(chain: LedgerChainView): Html {
  const status = chain.ok
    ? infoLine(html`<span data-ledger-chain="ok">Chain verified · ${chain.entries} entries through #${chain.through ?? 0} · head <span class="k-mono">${chain.head.slice(0, 16)}…</span>${chain.checkedAt === null ? "" : ` · checked in full ${chain.checkedAt.slice(11, 16)} UTC`}</span>`)
    : notice(html`<span data-ledger-chain="broken">Chain broken: ${chain.problem?.what ?? "the chain doesn't verify"}</span>`);
  const latest = chain.latest === null ? "" : note(html`Latest checkpoint (${chain.latest.at.slice(0, 16).replace("T", " ")} UTC). Copy it somewhere outside this machine: <span class="k-mono h-select">${chain.latest.through}:${chain.latest.hash}</span>`);
  const make = chain.csrf === null ? "" : postForm("/ledger/checkpoint", btn("Make a checkpoint", { sm: true, type: "submit", attrs: { "data-k-busy": "Making…" } }), { attrs: { class: "h-inline" } });
  const start = new Date(Date.parse(`${chain.today}T00:00:00Z`) - 29 * 86_400_000).toISOString().slice(0, 10);
  const exportForm = disclose("Audit export", html`<form method="get" action="/ledger/export" class="h-filters h-export" aria-label="Audit export">\
<div class="k-field"><label class="k-label" for="ledger-from">From</label><input class="k-input" id="ledger-from" type="date" name="from" value="${start}" required></div>\
<div class="k-field"><label class="k-label" for="ledger-to">To</label><input class="k-input" id="ledger-to" type="date" name="to" value="${chain.today}" required></div>\
<div class="k-acts">${btn("Download", { sm: true, type: "submit" })}</div></form>${note("Every entry in the range with its seal, and a full record for each task it names. JSON.")}`);
  return html`<section class="h-chain" aria-label="Audit log integrity">${status}${latest}${make}${exportForm}</section>`;
}

/** The audit log (`/ledger`): what people and tokens did, newest first, as quiet timed rows, with the filters, the CSV
 * and the sealed export. A kit list page: the top bar, then rows between hairlines. */
export function ledgerBody(rows: LedgerEntry[], projects: readonly string[], params: URLSearchParams, chain?: LedgerChainView): Html {
  const more = rows.length > 50;
  const shown = rows.slice(0, 50);
  const kept = new URLSearchParams();
  for (const key of ["project", "actor", "source", "outcome", "task"]) {
    const value = params.get(key); if (value) kept.set(key, value);
  }
  const next = new URLSearchParams(kept);
  if (shown.length) next.set("before", String(shown.at(-1)!.id));
  const csv = new URLSearchParams(kept); csv.set("format", "csv");
  const text = (id: string, label: string, name: string, placeholder: string): Html =>
    html`<div class="k-field"><label class="k-label" for="${id}">${label}</label><input class="k-input" id="${id}" type="text" name="${name}" value="${params.get(name) ?? ""}" placeholder="${placeholder}"></div>`;
  const filters = disclose(`Filters · ${kept.size === 0 ? "all actions" : `${kept.size} active`}`, html`<form method="get" action="/ledger" class="h-filters" aria-label="Filter the audit log">\
<div class="k-field"><label class="k-label" for="ledger-project">Project</label>${select({ id: "ledger-project", name: "project", wide: true, current: params.get("project") ?? "", items: [["", "All your projects"], ...projects.map(repo => [repo, projectName(repo)] as const)] })}</div>\
${text("ledger-actor", "Person or worker", "actor", "Anyone")}\
<div class="k-field"><label class="k-label" for="ledger-source">Events</label>${select({ id: "ledger-source", name: "source", wide: true, current: params.get("source") ?? "", items: [["", "All events"], ...EVENT_KINDS] })}</div>\
${text("ledger-outcome", "Outcome", "outcome", "Any outcome")}${text("ledger-task", "Task", "task", "Any task")}\
<div class="k-acts">${btn("Filter", { sm: true, type: "submit" })}${btn("Clear", { sm: true, variant: "ghost", href: "/ledger" })}</div></form>`, kept.size > 0);
  const list = shown.length === 0
    ? empty({ title: kept.size === 0 ? "Nothing yet." : "No actions match these filters.", text: kept.size === 0 ? "Approvals, invites, tokens and sign-ins appear here." : "Clear the filters to see every action." })
    : html`<div class="h-audit-list" aria-label="Action history">${shown.map(row => {
      const subject = row.runId !== null ? html`<a class="k-link" href="/r/${row.runId}">Run #${row.runId}</a>` : row.taskId !== null ? html`<a class="k-link k-mono" href="/t/${encodeURIComponent(row.taskId)}">${row.taskId}</a>` : "";
      const byActor = new URLSearchParams(kept); byActor.set("actor", row.actor);
      return html`<article class="h-audit" data-ledger-id="${row.id}"><span class="h-audit-time k-num">${exactWhenHtml(row.at)}</span>\
<span class="h-audit-what"><a class="h-actor" href="/ledger?${byActor.toString()}" title="Only this actor's actions">${row.actor}</a> ${row.action}${row.detail === null ? "" : html`<span class="h-audit-detail">${row.detail}</span>`}</span>\
<span class="h-audit-place">${row.repo === null ? "Instance" : projectName(row.repo)} ${subject}</span><span class="h-audit-out">${row.outcome} · ${row.source}</span></article>`;
    })}</div>`;
  const paging = kept.has("before") || params.has("before") || more
    ? acts(params.has("before") ? btn("Newest actions", { sm: true, variant: "ghost", href: `/ledger?${kept.toString()}` }) : "", more ? btn("Older actions", { sm: true, variant: "ghost", href: `/ledger?${next.toString()}`, attrs: { rel: "next" } }) : "")
    : "";
  return html`<div class="h-page h-ledger" data-kit-page>${pageHeader("Audit log", {
    ctx: "What people and tokens did, newest first. Times in UTC.",
    right: btn("Export CSV", { sm: true, variant: "ghost", href: `/ledger?${csv.toString()}`, attrs: { download: true } }),
  })}<div class="h-tools-row">${chain === undefined ? "" : chainHtml(chain)}${filters}</div>${list}<div class="h-foot-row">${paging}${note("Accepted requests record acceptance; worker events record results. History starts from the upgrade that added it. Review evidence is on each task or run. The CSV holds every matching action.")}</div></div>`;
}
