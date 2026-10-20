/**
 * A lead sweep's table (docs/plans/lead-fan-out.md): every child with its state, its verdict and its result, read from
 * facts on each look (the page follows the console's live beat). The only sweep-wide act is "cancel the rest"; steer,
 * cancel or retry one child is that task's own page.
 */
import { withActor } from "../actor.js";
import { CONSOLE_FORMS, readForm } from "../contracts/console-api.js";
import { html, postForm } from "../html.js";
import { sweepLine, sweepTable, type SweepRow } from "../lead-sweep.js";
import { refuse, screen } from "./chrome.js";
import type { HandlerContext } from "./handler-context.js";
import { handlersOf } from "./handler-registry.js";
import { redirect } from "./http.js";
import type { ServerRuntime } from "./runtime.js";

const SWEEP_PATH = /^\/sweeps\/([1-9][0-9]{0,9})(?:\/cancel-rest)?$/;
const STATE_WORDS: Record<SweepRow["state"], string> = {
  working: "Working", checking: "Checking", "needs-decision": "Needs you", "ready-to-check": "Ready", complete: "Complete", cancelled: "Cancelled", missing: "Gone",
};
/** A child not yet ready — working, being checked, or waiting on a decision: what cancel-rest stops. */
const OPEN: ReadonlySet<SweepRow["state"]> = new Set(["working", "checking", "needs-decision"]);

export function createSweepHandlers(runtime: ServerRuntime) {
  const { store, clock, sendScreen, chromeFor, evidenceRoot, consoleProjects, liveRefreshSeconds } = runtime;
  const readable = (): string[] => runtime.workAccess().repos ?? consoleProjects();

  async function page(ctx: HandlerContext): Promise<void> {
    const { url, who, response } = ctx;
    const id = Number(SWEEP_PATH.exec(url.pathname)?.[1]);
    const table = sweepTable(store, id, clock(), readable(), evidenceRoot);
    if (table === null) return refuse(response, who, 404, "There's no sweep at this address you can see.", "/chat");
    const said = url.searchParams.get("said");
    const rows = table.rows.map(row => html`<tr data-sweep-row="${row.ordinal}">
      <td>${row.ordinal + 1}</td>
      <td><a href="/t/${encodeURIComponent(row.task)}">${row.label}</a></td>
      <td><span class="chip">${STATE_WORDS[row.state]}</span></td>
      <td>${row.verdict === null ? html`<span class="meta">—</span>` : html`<strong>${row.verdict.verdict}</strong> <span class="meta">${row.verdict.why}</span>`}</td>
      <td>${row.result === null ? "" : html`<a href="/t/${encodeURIComponent(row.result.taskId)}">Result →</a>`}</td>
    </tr>`);
    const openCount = table.rows.filter(row => OPEN.has(row.state)).length;
    const cancel = who.role !== "approver" || openCount === 0 ? "" : html`<details class="card"><summary>Cancel the rest (${openCount})</summary>${postForm(`/sweeps/${id}/cancel-rest`, html`<p>Stops every item that isn't ready yet. Finished results stay.</p><label class="arm"><input type="checkbox" name="confirm" value="yes" required> Cancel ${openCount} unfinished item${openCount === 1 ? "" : "s"}</label><button class="danger">Cancel the rest</button>`)}</details>`;
    const body = html`<h1>${table.title}</h1>${said === null ? "" : html`<p role="status">${said}</p>`}
      <p class="meta">${sweepLine(table)} · at most ${table.maxParallel} at once · each item is its own task in its own worktree</p>
      <table class="sweep-table"><thead><tr><th>#</th><th>Item</th><th>State</th><th>Verdict</th><th></th></tr></thead><tbody>${rows}</tbody></table>${cancel}`;
    return sendScreen(response, 200, screen(table.title, body, { chrome: chromeFor(table.repo, "work"), refreshSeconds: liveRefreshSeconds() }));
  }

  async function cancelRest(ctx: HandlerContext): Promise<void> {
    const { url, who, response, posted } = ctx;
    const id = Number(SWEEP_PATH.exec(url.pathname)?.[1]);
    const body = readForm(posted, CONSOLE_FORMS.sweep);
    const table = sweepTable(store, id, clock(), readable(), evidenceRoot);
    if (table === null) return refuse(response, who, 404, "There's no sweep at this address you can see.", "/chat");
    if (body.get("confirm") !== "yes") return redirect(response, `/sweeps/${id}?said=${encodeURIComponent("Tick the box to cancel the rest.")}`);
    const now = clock();
    let cancelled = 0;
    for (const row of table.rows.filter(one => OPEN.has(one.state))) {
      const result = withActor({ account: who.name, lead: false }, () => store.cancelTask(row.task, now));
      if (result.ok) cancelled += 1;
    }
    return redirect(response, `/sweeps/${id}?said=${encodeURIComponent(`Cancelled ${cancelled} unfinished item${cancelled === 1 ? "" : "s"}. Finished results stay.`)}`);
  }

  return { registrations: handlersOf("tasks", { "sweep.page": page, "sweep.cancel-rest": cancelRest }) };
}
