// @vitest-environment happy-dom
/**
 * The inline decision enhancement, EXECUTED (portfolio arc slice 1; commit-1
 * review finding 6): not the markup contract — serve.test.ts owns that — but
 * the script itself running against a DOM: the urlencoded POST, the landed-
 * pathname check, the card-local receipt swap, and the no-refresh guarantee
 * that neighboring typed input survives an answer.
 */
import { describe, test, expect, vi, beforeEach } from "vitest";
import { decisionAnswerScript } from "./serve.js";

const CARD = (id: number): string =>
  `<form class="card" id="capture"><input type="text" id="qc" name="title"></form>` +
  `<div class="decide-card" data-decision-id="${id}">` +
  `<p class="q">Which way?</p>` +
  `<div class="decide-options">` +
  `<form class="decide-option decide-inline" method="post" action="/d/${id}/answer">` +
  `<input type="hidden" name="csrf" value="deadbeef">` +
  `<input type="hidden" name="choice" value="keep">` +
  `<button type="submit">Keep and backfill</button>` +
  `</form></div></div>`;

const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

describe("decisionAnswerScript, executed", () => {
  beforeEach(() => {
    document.body.innerHTML = CARD(7);
    (document.getElementById("qc") as HTMLInputElement).value = "typed, not yet saved";
    // eslint-disable-next-line no-eval -- the shipped inline script, verbatim
    eval(decisionAnswerScript());
  });

  const submit = (): void => {
    const form = document.querySelector("form.decide-inline");
    if (form === null) throw new Error("no inline form");
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  };

  test("a successful answer swaps only the card for the receipt; typed input survives", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve({
        ok: true,
        url: `${location.origin}/d/7`,
        text: () =>
          Promise.resolve(`<html><body><div class="answered">Answered: <strong>keep</strong> by alex</div></body></html>`),
      });
    });

    submit();
    await flush();

    // The forms-only gate's exact transport: urlencoded, fields intact.
    expect(calls.length).toBe(1);
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(String(calls[0]?.init.body)).toContain("choice=keep");
    expect(String(calls[0]?.init.body)).toContain("csrf=deadbeef");

    // The card became the decision page's own receipt — nothing else moved.
    const card = document.querySelector('[data-decision-id="7"]');
    expect(card?.textContent).toContain("Answered:");
    expect(card?.querySelector("form")).toBeNull();
    expect(document.getElementById("capture")).not.toBeNull();
    expect((document.getElementById("qc") as HTMLInputElement).value).toBe("typed, not yet saved");
  });

  test("landing anywhere but the decision page inserts nothing", async () => {
    vi.stubGlobal("fetch", () =>
      Promise.resolve({
        ok: true,
        url: `${location.origin}/login`,
        text: () => Promise.resolve(`<html><body><div class="answered">forged</div></body></html>`),
      }));

    submit();
    await flush();

    // The card is untouched — no forged receipt was inserted. (The shipped
    // script navigates to the decision page; navigation itself is the
    // browser's, not this test's, concern.)
    const card = document.querySelector('[data-decision-id="7"]');
    expect(card?.textContent).not.toContain("forged");
    expect(card?.querySelector("form.decide-inline")).not.toBeNull();
  });
});
