/**
 * Chat in `toolroll demo`: the scripted lead's conversation (src/demo.ts),
 * rendered as plain server HTML with native forms. One small script keeps a
 * running build's progress live; without it the page still works by reload.
 */
import { START_COMMAND } from "./first-run.js";
import { html, postForm, type Html } from "./html.js";
import { headlineOf } from "./task-status.js";
import type { DemoExchange } from "./demo.js";

/** What a finished exchange's stored result holds, read back from its evidence. */
export type DemoResultView = {
  diff: string | null;
  checkLog: string | null;
  checks: { status: string; detail: string };
  screenshot: { href: string; caption: string } | null;
  additions: number;
  deletions: number;
  files: number;
  taskHref: string;
};

const SUGGESTIONS = ["Fix the flaky refund test", "Rewrite the empty Payouts page", "Put the new invoice view behind a flag"];

function hint(): Html {
  return html`<section class="demo-hint" aria-label="Get started"><p class="demo-hint-title">Ask for something, like “fix the flaky refund test”</p>${
    postForm("/chat/demo/ask", SUGGESTIONS.map(one => html`<button type="submit" name="message" value="${one}">${one}</button>`), { attrs: { class: "demo-suggestions" } })}</section>`;
}

function planCard(exchange: DemoExchange): Html {
  const plan = exchange.plan;
  const goal = exchange.note === null ? plan.goal : `${plan.goal} Also: ${exchange.note}`;
  const actions = exchange.state === "proposed"
    ? html`<div class="demo-actions">${postForm(`/chat/demo/${exchange.id}/approve`, html`<button type="submit">Approve</button>`, { attrs: { class: "approve-form" } })}<details class="demo-more"><summary>Change it</summary>${
      postForm(`/chat/demo/${exchange.id}/change`, html`<label for="demo-change-${exchange.id}">What should change?</label><textarea id="demo-change-${exchange.id}" name="note" rows="2" maxlength="500" required></textarea><button type="submit">Update plan</button>`)}</details></div>`
    : exchange.state === "replaced"
      ? html`<p class="meta">Replaced by the updated plan below.</p>`
      : html`<p class="meta">Approved.</p>`;
  return html`<section class="card demo-plan" aria-label="Plan"><p class="demo-kicker">Plan · ${plan.project}</p><h2>${plan.title}</h2><p>${goal}</p><h3>Boundaries</h3><ul>${plan.boundaries.map(one => html`<li>${one}</li>`)}</ul><h3>Checks</h3><ul>${plan.checks.map(one => html`<li>${one}</li>`)}</ul>${actions}</section>`;
}

function buildCard(exchange: DemoExchange): Html {
  const stages = [["planning", "Planning"], ["building", "Building"], ["checking", "Running checks"]] as const;
  const at = stages.findIndex(([key]) => key === exchange.stage);
  return html`<section class="card demo-build" id="demo-${exchange.id}-work" aria-label="Build" aria-busy="true"><p class="demo-kicker">${exchange.plan.project}</p><h2>${stages[Math.max(0, at)]![1]}…</h2><ol class="demo-steps">${stages.map(([, label], index) =>
      html`<li class="${index < at ? "done" : index === at ? "now" : ""}"${index === at ? html` aria-current="step"` : ""}>${label}</li>`)}</ol>${
    exchange.progress === null ? "" : html`<p class="meta demo-progress">${exchange.progress}</p>`}</section>`;
}

function diffHtml(diff: string): Html[] {
  return diff.replace(/\n$/, "").split("\n").map(line => {
    const kind = line.startsWith("diff --git") || line.startsWith("new file") ? "file"
      : line.startsWith("+++") || line.startsWith("---") ? "meta"
      : line.startsWith("@@") ? "hunk"
      : line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "ctx";
    return html`<span class="demo-diff-${kind}">${line || " "}</span>`;
  });
}

function resultCard(exchange: DemoExchange, result: DemoResultView | null): Html {
  if (result === null) return html`<section class="card demo-result"><p class="meta">This result's saved evidence is unavailable.</p></section>`;
  const passed = result.checks.status === "passed";
  // The shared headline (task-status.ts): the same words as every real task.
  const headline = headlineOf({ stage: exchange.state === "complete" ? "complete" : exchange.state === "sent-back" ? "building" : "finished",
    checks: { status: passed ? "passed" : "failed", exitCode: null, head: null } });
  const status = html`<span class="badge${headline === "Complete" ? " demo-complete" : headline === "Ready for review" ? " demo-ready" : ""}" data-headline="${headline}">${headline}</span>`;
  const summary = html`${result.files} file${result.files === 1 ? "" : "s"} changed · +${result.additions} −${result.deletions} · <span class="${passed ? "demo-pass" : "demo-fail"}">${result.checks.detail}</span>`;
  const actions = exchange.state === "ready"
    ? html`<div class="demo-actions">${postForm(`/chat/demo/${exchange.id}/complete`, html`<button type="submit" class="demo-primary">Complete</button>`)}<details class="demo-more"><summary>Request changes</summary>${
      postForm(`/chat/demo/${exchange.id}/revise`, html`<label for="demo-revise-${exchange.id}">What should change?</label><textarea id="demo-revise-${exchange.id}" name="note" rows="2" maxlength="500" required></textarea><button type="submit">Send back</button>`)}</details></div>`
    : html`<p class="meta"><a href="${result.taskHref}">Open in Tasks</a></p>`;
  return html`<section class="card demo-result" id="demo-${exchange.id}-work" aria-label="Result"><p class="demo-state">${status}<span class="meta">${exchange.plan.project}</span></p><h2>${exchange.plan.title}</h2><p>${exchange.plan.conclusion}</p><p class="meta">${summary}</p>${actions}${
    result.diff === null ? "" : html`<details class="demo-evidence"${exchange.state === "ready" ? html` open` : ""}><summary>Changes</summary><pre class="demo-diff">${diffHtml(result.diff)}</pre></details>`}${
    result.checkLog === null ? "" : html`<details class="demo-evidence"><summary>Check log</summary><pre class="demo-log">${result.checkLog}</pre></details>`}${
    result.screenshot === null ? "" : html`<details class="demo-evidence"><summary>Screenshot</summary><figure><img src="${result.screenshot.href}" alt="${result.screenshot.caption}" width="960" height="600"><figcaption class="meta">${result.screenshot.caption}</figcaption></figure></details>`}</section>`;
}

/** The conversation itself; the live script swaps this region in place. */
export function demoThreadHtml(exchanges: readonly DemoExchange[], resultOf: (exchange: DemoExchange) => DemoResultView | null): Html {
  if (exchanges.length === 0) return hint();
  return html`${exchanges.map(exchange => {
    const parts: Html[] = [
      html`<div class="demo-said demo-you"><p>${exchange.asked}</p></div>`,
      html`<div class="demo-said demo-lead"><p class="demo-who">Lead</p><p>${exchange.reply}</p></div>`,
      planCard(exchange),
    ];
    if (exchange.state === "working") parts.push(buildCard(exchange));
    if (exchange.state === "ready" || exchange.state === "complete" || exchange.state === "sent-back") parts.push(resultCard(exchange, resultOf(exchange)));
    if (exchange.state === "complete") {
      parts.push(html`<div class="demo-said demo-lead"><p class="demo-who">Lead</p><p>Done. That's the whole loop: ask, approve, Ready, Complete. Ask for something else whenever you like.</p></div>`,
        html`<section class="card demo-handoff" data-demo-handoff aria-label="Your own project"><h2>Now try it on your own project</h2><p>In your repository's folder, run:</p><pre class="demo-command"><code>${START_COMMAND}</code></pre><p class="meta">It opens in your browser, already signed in.</p></section>`);
    }
    return html`<article class="demo-turn" id="demo-${exchange.id}">${parts}</article>`;
  })}`;
}

export function demoChatHtml(input: { exchanges: readonly DemoExchange[]; version: number; problem: string | null; resultOf: (exchange: DemoExchange) => DemoResultView | null }): Html {
  const working = input.exchanges.some(one => one.state === "working");
  return html`<div class="demo-chat">${input.problem === null ? "" : html`<p class="problem" role="alert">${input.problem}</p>`}<div id="demo-thread" class="demo-thread" aria-live="polite" data-version="${input.version}" data-working="${working ? "1" : "0"}">${
    demoThreadHtml(input.exchanges, input.resultOf)}</div>${
    postForm("/chat/demo/ask", html`<label for="demo-message" class="so-sr-only">Message the lead</label><textarea id="demo-message" name="message" rows="2" maxlength="500" placeholder="Ask the lead for a change" required></textarea><button type="submit" class="demo-primary">Send</button>`, { attrs: { class: "demo-composer" } })}</div>`;
}

/**
 * Keeps a running build live: polls while one is working and swaps the
 * thread in place, unless the visitor is typing inside it. Enter sends.
 */
export const DEMO_CHAT_SCRIPT = `(() => {
  const thread = () => document.getElementById("demo-thread");
  let timer = 0;
  const editing = region => region.contains(document.activeElement) && document.activeElement.matches("textarea, input") || region.querySelector("details[open] textarea:not(:placeholder-shown)") !== null;
  const tick = async () => {
    const region = thread();
    if (!region) { timer = setTimeout(tick, 400); return; }
    if (region.dataset.working !== "1") return;
    try {
      const answer = await fetch("/chat/demo/live", { headers: { accept: "application/json" }, credentials: "same-origin" });
      if (answer.ok) {
        const next = await answer.json();
        if (String(next.version) !== region.dataset.version && !editing(region)) {
          region.innerHTML = next.html;
          region.dataset.version = String(next.version);
          region.dataset.working = next.working ? "1" : "0";
          if (!next.working) {
            const last = region.querySelector(".demo-turn:last-of-type .demo-result");
            if (last) last.scrollIntoView({ block: "nearest", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
          }
        }
      }
    } catch { /* the next tick tries again */ }
    if (thread()?.dataset.working === "1") timer = setTimeout(tick, 700);
  };
  const start = () => { clearTimeout(timer); tick(); };
  document.addEventListener("keydown", event => {
    const field = event.target;
    if (event.key !== "Enter" || event.shiftKey || event.isComposing || !(field instanceof HTMLTextAreaElement) || field.id !== "demo-message") return;
    if (field.value.trim() === "") return;
    event.preventDefault();
    field.form?.requestSubmit();
  });
  window.addEventListener("standing-orders:workspace-rendered", start);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();`;
