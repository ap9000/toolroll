/**
 * Settings → Updates: the installed version, one of three ways to update
 * (behind the operator's password), the update's steps live while it runs,
 * and a one-time "What's new" section afterwards. The work itself is the
 * `toolroll update` command (toolroll-update.ts), started as its own job.
 * Built from the revamp kit; the Settings frame adds the title.
 */
import { html, joinHtml, postForm, type Html } from "./html.js";
import type { InstallMethod } from "./install-method.js";
import { STEP_WORDS, UPDATE_STEPS, runtimeUpdateTerminal, type RuntimeUpdateJournal, type UpdateStep } from "./toolroll-update.js";
import { btn, chip, codeLine, disclose, formRow, infoLine, note, notice, radios, settingsRecord, settingsSection } from "./server/kit.js";
import { kitSectionForm } from "./settings-kit.js";

const clock = (iso: string) => { const d = new Date(iso); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };

/** The page is kit pieces now; nothing of the old look is left. Kept as an export for the shared stylesheet. */
export const UPDATES_CSS = "";

export type UpdatesView = {
  current: string;
  /** The newest release, why it is unknown, or not asked because update checks are off. */
  latest: { version: string } | { problem: string } | { off: true } | { pending: true };
  method: InstallMethod;
  journal: RuntimeUpdateJournal | null;
  running: boolean;
  whatsNew: { version: string; notes: string[] } | null;
  /** The version `toolroll update --rollback` returns to: the last completed update's, while it is what runs. */
  rollbackTo: string | null;
  csrf: string;
};

/** A step's state as one of the kit's status words. */
const STEP_CHIP: Record<"done" | "now" | "failed" | "waiting", Html> = {
  done: chip("Finished", "done"), now: chip("Running", "live"), failed: chip("Failed", "failed"), waiting: chip("Queued", ""),
};

/** The steps, each done, current, failed or waiting. Also the live region's fragment. */
export function updateStepsHtml(j: RuntimeUpdateJournal, running: boolean, options: { title?: boolean } = {}): Html {
  const finished = runtimeUpdateTerminal(j.phase);
  const failed = ["restored", "refused", "needs-attention", "rolling-back"].includes(j.phase);
  const last = UPDATE_STEPS.indexOf([...j.steps].reverse().find(s => (UPDATE_STEPS as readonly string[]).includes(s.phase))?.phase as UpdateStep);
  const items = UPDATE_STEPS.map((step: UpdateStep, i) => {
    const state = j.phase === "complete" || i < last ? "done" : i > last ? "waiting" : failed ? "failed" : finished ? "waiting" : "now";
    // Only where it adds something: which work it waits for, or what went wrong.
    const detail = state === "now" && step === "draining" && j.waiting ? html`${j.waiting.on}.${j.waiting.action ? html` If nothing of it is running, run <code class="k-mono">${j.waiting.action}</code>.` : ""}`
      : (state === "now" && step === "draining") || (state === "failed" && j.phase === "rolling-back") ? html`${j.detail}` : "";
    return settingsRecord({ title: STEP_WORDS[step], sub: detail, when: STEP_CHIP[state], attrs: { "data-step": step, "data-state": state } });
  });
  const title = j.phase === "scheduled" ? `Update to ${j.to.version} scheduled for ${clock(j.at ?? j.startedAt)}`
    : j.phase === "rolling-back" ? `Restoring ${j.from.version}`
    : j.kind === "rollback" ? `Rolling back to ${j.to.version}` : `Updating to ${j.to.version}`;
  const stalled = !running && !finished ? notice(html`The updater stopped. Run <code class="k-mono">toolroll update --resume</code> to continue it.`) : "";
  return html`<div id="update-live" data-phase="${j.phase}" data-done="${finished ? 1 : 0}">${options.title === false ? "" : html`<p><b>${title}</b></p>`}${
    j.phase === "scheduled" ? note("Running work finishes first. You can close this page.") : html`<div aria-label="Update steps">${items}</div>`}${stalled}</div>`;
}

function outcomeHtml(j: RuntimeUpdateJournal): Html | "" {
  if (j.phase === "complete") {
    return j.kind === "rollback" ? settingsSection({ id: "update-outcome", title: `Back on ${j.to.version}`, body: html`<div data-update-outcome="rolled-back">${note(j.detail)}</div>` }) : "";
  }
  if (j.phase === "cancelled") return settingsSection({ id: "update-outcome", title: "Update cancelled", body: html`<div data-update-outcome="cancelled">${note("Nothing changed.")}</div>` });
  // Stopped on a finished run it can't show has ended: what is in the way and the one command, nothing more.
  if (j.phase === "refused" && j.waiting) {
    return settingsSection({ id: "update-outcome", title: `Update to ${j.to.version} stopped: run #${j.waiting.run} is in the way`,
      body: html`<div data-update-outcome="stopped">${infoLine(`${j.waiting.on}. New work resumed.`)}${
        j.waiting.action ? note(html`If nothing of it is running, run <code class="k-mono">${j.waiting.action}</code>, then update again.`) : note("Update again once it has stopped.")}</div>` });
  }
  const title = j.phase === "refused" ? `Didn't update to ${j.to.version}` : j.phase === "restored" ? `Update to ${j.to.version} didn't finish` : "The update needs attention";
  return settingsSection({ id: "update-outcome", title, state: html` ${chip("Failed", "failed")}`,
    body: html`<div data-update-outcome="${j.phase}">${j.phase === "needs-attention" ? notice(j.detail) : html`<p class="k-note" role="alert">${j.detail}</p>`}${
      disclose("Steps", updateStepsHtml(j, false, { title: false }))}</div>` });
}

export function updatesHtml(view: UpdatesView, said: { said?: string | null; problem?: string | null }): Html {
  const answer = said.problem ? notice(said.problem) : said.said ? infoLine(said.said) : "";
  const j = view.journal;
  const active = j !== null && !runtimeUpdateTerminal(j.phase);
  const whatsNew = view.whatsNew === null ? "" : settingsSection({ id: "whats-new", title: `What’s new in ${view.whatsNew.version}`,
    right: postForm("/settings/updates/seen", btn("Got it", { sm: true, type: "submit" })),
    body: html`<div data-whats-new="${view.whatsNew.version}">${view.whatsNew.notes.length > 0 ? view.whatsNew.notes.map(line => note(line)) : ""}${
      note(html`<a class="k-link" href="https://github.com/ap9000/toolroll/releases/tag/v${view.whatsNew.version}" rel="noreferrer">Full release notes</a>`)}</div>` });
  if (active) {
    const cancel = ["scheduled", "draining"].includes(j.phase) ? postForm("/settings/updates/cancel", btn("Cancel update", { sm: true, type: "submit" })) : "";
    return settingsSection({ id: "update", title: "Update", state: html` ${chip("Running", "live")}`, ...(cancel === "" ? {} : { right: cancel }),
      body: joinHtml([answer, html`<div id="update-region">${updateStepsHtml(j, view.running)}</div>`, html`<p class="k-note" id="update-region-stamp" aria-live="polite"></p>`]) });
  }
  const latest = "version" in view.latest ? view.latest.version : null;
  const newer = latest !== null && newerThan(latest, view.current);
  const check = postForm("/settings/updates/check", btn("Check now", { sm: true, type: "submit" }));
  const state: [title: string, line: string, action: Html | ""] = view.method.kind === "npx" ? [`Toolroll ${view.current}`, "npx runs the latest release each time, so this is current.", ""]
    : view.method.kind === "source" ? [`Toolroll ${view.current}`, "This runs from a source checkout. Update it with git.", ""]
    : newer && view.method.kind === "desktop" ? [`Toolroll ${latest} is available`, `You have ${view.current}. Update it from the Toolroll app.`, ""]
    : newer ? [`Toolroll ${latest} is available`, `You have ${view.current}. Running work finishes first, and your current version is kept so you can go back.`, ""]
    : "off" in view.latest ? [`Toolroll ${view.current}`, "Update checks are off.", check]
    : "pending" in view.latest ? [`Toolroll ${view.current}`, "Not checked for a newer release yet.", check]
    : latest === null ? [`Toolroll ${view.current}`, `Couldn’t check for a newer release: ${"problem" in view.latest ? view.latest.problem : ""}`, ""]
    : [`Toolroll ${view.current} is up to date`, "", ""];
  const form = newer && !["npx", "source", "desktop"].includes(view.method.kind)
    ? kitSectionForm({ proof: "updates", action: "/settings/updates", id: "update-form", hidden: { version: latest }, save: { label: `Update to ${latest}` }, confirm: `Update Toolroll to ${latest}`,
      body: formRow("When", null, radios({ name: "when", legend: "When", current: "now", items: [
        { value: "now", label: "Now", text: "Only when no work is running." },
        { value: "when-idle", label: "When idle", text: "Once nothing is running." },
        { value: "tonight", label: "Tonight (03:00)", text: "At 03:00 on the computer running Toolroll." }] }), "wide") })
    : "";
  const rollback = view.rollbackTo !== null ? joinHtml([note(`To go back to ${view.rollbackTo}:`), codeLine("toolroll update --rollback")]) : "";
  const version = settingsSection({ id: "update", title: state[0], ...(state[2] === "" ? {} : { right: state[2] }),
    body: html`<div data-update-state="${newer ? "available" : "current"}">${joinHtml([answer, state[1] === "" ? "" : note(state[1]), form, rollback])}</div>` });
  return joinHtml([whatsNew, j ? outcomeHtml(j) : "", version]);
}

export function newerThan(a: string, b: string): boolean {
  const [x, y] = [a, b].map(v => v.split(".").map(Number));
  for (let i = 0; i < 3; i++) if ((x![i] ?? 0) !== (y![i] ?? 0)) return (x![i] ?? 0) > (y![i] ?? 0);
  return false;
}

/** Polls the steps every two seconds, keeps trying while the console
 * restarts, and reloads once the update has finished. */
export function updatesScript(): string {
  return `(function(){var region=document.getElementById("update-region");if(!region)return;var stamp=document.getElementById("update-region-stamp");var misses=0;` +
    `function tick(){if(document.hidden){setTimeout(tick,2000);return;}fetch("/settings/updates?fragment=steps",{credentials:"same-origin",cache:"no-store"}).then(function(r){if(!r.ok)throw 0;return r.text();}).then(function(html){misses=0;if(stamp)stamp.textContent="";` +
    `var live=region.querySelector("#update-live");if(live)live.outerHTML=html;var now=region.querySelector("#update-live");if(now&&now.getAttribute("data-done")==="1"){location.reload();return;}setTimeout(tick,2000);})` +
    `.catch(function(){misses++;if(stamp)stamp.textContent=misses>2?"Reconnecting while Toolroll restarts…":"";setTimeout(tick,Math.min(10000,2000*misses));});}setTimeout(tick,2000);})();`;
}
