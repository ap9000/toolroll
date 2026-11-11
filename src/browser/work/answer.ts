/**
 * Answering a question on the page it is asked on, run by the app (docs/plans/task-page-in-app.md §4). It is the
 * app's version of `decisionAnswerScript` (server/render-tasks.ts), kept the same by one test table that runs against
 * both: the same POST to the form's own action with the same body, the same landed-page check, the same card-local
 * receipt. Two differences, both because the app changes pages without a document load: every listener ends with
 * `signal`, and an answer that lands after the page was replaced touches nothing and loads nothing. (Stopping never
 * undoes an answer the server already took: the POST is not aborted.)
 */
import { loadDocument } from "../navigate.js";

export type AnswerDeps = { fetch: typeof fetch; load: (href: string) => void };

export function answerWork(signal: AbortSignal, deps: AnswerDeps = { fetch: (input, init) => fetch(input, init), load: href => loadDocument(href) }): void {
  if (signal.aborted) return;
  document.addEventListener("submit", event => {
    const form = event.target as HTMLFormElement | null;
    if (!form || !form.classList || !form.classList.contains("decide-inline")) return;
    event.preventDefault();
    const card = form.closest("[data-decision-id]");
    // The action attribute, not form.action: a field named "action" would shadow that property (DOM clobbering).
    const to = new URL(HTMLFormElement.prototype.getAttribute.call(form, "action") || "", window.location.href).href;
    const page = to.replace(/\/answer$/, "");
    const leave = (): void => { if (!signal.aborted) deps.load(page); };
    // `new FormData(form)` fires `formdata`, so the shell's key fill adds this tab's key as on any form.
    const body = new URLSearchParams(new FormData(form) as unknown as Record<string, string>).toString();
    deps.fetch(to, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/x-www-form-urlencoded" }, body })
      .then(response => response.text().then(text => ({ response, text })))
      .then(({ response, text }) => {
        if (signal.aborted) return;
        let landed = "";
        try { landed = new URL(response.url).pathname; } catch { /* no address: not the decision's page */ }
        if (!response.ok || landed !== new URL(page, window.location.href).pathname) { leave(); return; }
        const receipt = new DOMParser().parseFromString(text, "text/html").querySelector(".answered");
        if (!card) { leave(); return; }
        if (receipt) card.replaceChildren(document.importNode(receipt, true)); else card.remove();
      }, leave);
  }, { signal });
}
