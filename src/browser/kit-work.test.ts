// @vitest-environment happy-dom
/** k-work (src/design/KIT.md "The work"): the server's `work` and React's `KWork` draw the same frame, so a page without
 * script and the workspace never have two looks. */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { html, htmlString } from "../html.js";
import { work } from "../server/kit.js";
import { KWork } from "./kit/index.js";

/** One element tree as text with each element's attributes in name order (the two writers order them differently). */
function canonical(markup: string): string {
  const host = document.createElement("div");
  host.innerHTML = markup;
  const walk = (node: Node): string => {
    if (node.nodeType === 3) return node.textContent ?? "";
    if (!(node instanceof Element)) return "";
    const attrs = [...node.attributes].map(one => `${one.name}="${one.value}"`).sort().join(" ");
    return `<${node.tagName.toLowerCase()}${attrs === "" ? "" : ` ${attrs}`}>${[...node.childNodes].map(walk).join("")}</${node.tagName.toLowerCase()}>`;
  };
  return [...host.childNodes].map(walk).join("");
}

test("the server and React draw the same frame", () => {
  const cases: { live: boolean; who: string; foot: string | null; close: boolean; hidden: boolean }[] = [
    { live: true, who: "Claude Sonnet · working", foot: "The box", close: true, hidden: false },
    { live: false, who: "Claude Sonnet · finished", foot: null, close: false, hidden: true },
    { live: false, who: "", foot: null, close: true, hidden: false },
  ];
  for (const one of cases) {
    const server = htmlString(work({ id: "task-activity", title: "Activity", who: one.who, live: one.live, close: one.close ? "Close activity" : null, hidden: one.hidden,
      body: html`<p>The records</p>`, ...(one.foot === null ? {} : { foot: html`<p>${one.foot}</p>` }) }));
    const react = renderToStaticMarkup(createElement(KWork, { id: "task-activity", title: "Activity", who: one.who, live: one.live, hidden: one.hidden, closeLabel: "Close activity",
      ...(one.close ? { onClose: () => {} } : {}), ...(one.foot === null ? {} : { foot: createElement("p", null, one.foot) }) }, createElement("p", null, "The records")));
    expect(canonical(react)).toBe(canonical(server));
  }
  // What the markup promises: an aside named by its heading, a blue dot only while it runs, a Close read aloud.
  const host = document.createElement("div");
  host.innerHTML = htmlString(work({ id: "w", title: "Activity", who: "Claude Sonnet · working", live: true, close: "Close activity", body: html`` }));
  const aside = host.querySelector("aside.k-work")!;
  expect(host.querySelector(`#${aside.getAttribute("aria-labelledby")}`)?.textContent).toBe("Activity");
  expect(host.querySelectorAll(".k-work-dot")).toHaveLength(1);
  expect(host.querySelector(".k-work-head button")?.getAttribute("aria-label")).toBe("Close activity");
  expect(host.querySelector(".k-work-foot")).toBeNull();
});
