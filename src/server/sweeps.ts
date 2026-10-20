/**
 * A lead sweep's table (docs/plans/lead-fan-out.md): every child with its state, its verdict and its result, read from
 * facts on each look (the page follows the console's live beat). The only sweep-wide act is "cancel the rest"; steer,
 * cancel or retry one child is that task's own page.
 */
import { CONSOLE_FORMS, readForm } from "../contracts/console-api.js";
import { html, postForm } from "../html.js";
import { cancelSweepRest, sweepLine, sweepOpen, sweepOpenDigest, sweepTable, type SweepRow } from "../lead-sweep.js";
import { refuse, screen } from "./chrome.js";
import type { HandlerContext } from "./handler-context.js";
import { handlersOf } from "./handler-registry.js";
import { redirect } from "./http.js";
import type { ServerRuntime } from "./runtime.js";

const SWEEP_PATH = /^\/sweeps\/([1-9][0-9]{0,9})(?:\/cancel-rest)?$/;
const STATE_WORDS: Record<SweepRow["state"], string> = {
  working: "Working", checking: "Checking", "needs-decision": "Needs you", "ready-to-check": "Ready", complete: "Complete", cancelled: "Cancelled", missing: "Gone",
};

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
    // The form names exactly what it would act on (each item's active task, state and attempt): a change is refused.
    const open = sweepOpen(store, table, clock());
    const running = open.filter(one => one.run !== null).length;
    const cancel = who.role !== "approver" || open.length === 0 ? "" : html`<details class="card"><summary>Cancel the rest (${open.length})</summary>${postForm(`/sweeps/${id}/cancel-rest`, html`<p>Cancels ${open.length - running} unfinished item${open.length - running === 1 ? "" : "s"}${running === 0 ? "" : ` and stops ${running} running build${running === 1 ? "" : "s"}`}: ${open.map(one => one.label).join(", ")}. Finished results stay.</p><label class="arm"><input type="checkbox" name="confirm" value="yes" required> Cancel the rest</label><button class="danger">Cancel the rest</button>`, { hidden: { snapshot: sweepOpenDigest(open) } })}</details>`;
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
    const open = sweepOpen(store, table, now);
    if (body.get("snapshot") !== sweepOpenDigest(open)) return redirect(response, `/sweeps/${id}?said=${encodeURIComponent("The sweep changed while you were reading. Look again, then cancel.")}`);
    return redirect(response, `/sweeps/${id}?said=${encodeURIComponent(cancelSweepRest(store, who.name, open, now, "web"))}`);
  }

  return { registrations: handlersOf("tasks", { "sweep.page": page, "sweep.cancel-rest": cancelRest }) };
}
