// @vitest-environment happy-dom
/** k-steprows (src/design/KIT.md "Step rows"): the server's stepRows and React's KStepRows write the same markup for the
 * same rows, so the page without script and the workspace never have two looks. */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { html, htmlString } from "../html.js";
import { stepRows, type StepRowItem } from "../server/kit.js";
import { KStepRows } from "./kit/index.js";

const ROWS: StepRowItem[] = [
  { key: "plan", label: "Plan", mark: "done", sentence: "Add subtract next to add", at: "2026-11-10T23:28:00.000Z", when: "23:28", toggle: true, open: false },
  { key: "approve", label: "Approval", mark: "done", sentence: "Approved by alex", at: "2026-11-10T23:30:00.000Z", when: "23:30", toggle: true, open: true },
  { key: "build", label: "Build", mark: "needs", sentence: "", needsYou: true, current: true, open: true },
  { key: "checks", label: "Checks", mark: "skipped", sentence: "The checks didn't run" },
  { key: "ready", label: "Ready", mark: "todo", sentence: "A result for you to review", toggle: true, open: false },
];

/** One DOM's markup, attribute names as the HTML parser reads them. */
const normal = (markup: string): string => { const host = document.createElement("div"); host.innerHTML = markup; return host.innerHTML; };

test("the server and React draw the same step rows", () => {
  const bodies = ["The plan", "Approved", "Building", null, "The result"];
  const server = htmlString(stepRows(ROWS.map((row, index) => ({ ...row, ...(bodies[index] === null ? {} : { body: html`<p>${bodies[index]!}</p>` }) }))));
  const react = renderToStaticMarkup(createElement(KStepRows, { rows: ROWS.map((row, index) => ({ ...row, ...(bodies[index] === null ? {} : { body: createElement("p", null, bodies[index]!) }) })) }));
  expect(normal(react)).toBe(normal(server));
  // What the markup promises: the current row is aria-current; a toggle names its body; a closed body is hidden.
  const host = document.createElement("div"); host.innerHTML = server;
  expect(host.querySelector('[data-step-row="build"]')!.getAttribute("aria-current")).toBe("step");
  const toggle = host.querySelector<HTMLButtonElement>('[data-step-row="ready"] button.k-steprow-head')!;
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(host.querySelector(`#${toggle.getAttribute("aria-controls")}`)!.hasAttribute("hidden")).toBe(true);
  // A row with no body is one line and nothing to press.
  expect(host.querySelector('[data-step-row="checks"] button')).toBeNull();
  expect(host.querySelector('[data-step-row="checks"] .k-steprow-body')).toBeNull();
  // An empty body is no body, on both sides.
  const empty = { key: "x", label: "X", mark: "done" as const, sentence: "s", toggle: true };
  expect(normal(renderToStaticMarkup(createElement(KStepRows, { rows: [{ ...empty, body: "" }] })))).toBe(normal(htmlString(stepRows([{ ...empty, body: html`` }]))));
  // The state is read aloud with the label; the wait on the viewer is the one ink chip.
  expect(host.querySelector('[data-step-row="build"] .k-steprow-label')!.textContent).toBe("Build, waiting on you");
  expect(host.querySelectorAll(".k-chip.needs")).toHaveLength(1);
});
