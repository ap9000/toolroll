// @vitest-environment happy-dom
/**
 * The React workspace's scoped preflight (tailwind.css) resets bare elements inside a rebuilt view. It must leave the
 * revamp kit alone: every element of a piece whose markup the kit owns is styled by kit.css, often by element
 * (a tab's button, a disclosure's summary, a doc header's h1), and a reset there strips it (Codex wave 0 r1 #3).
 * Page content a kit container holds still gets the reset.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, test } from "vitest";
import { KComposer, KDisclose, KDoc, KDocHeader, KFacts, KFormRow, KPageHeader, KRadios, KSeg, KSettingsShell, KSlots, KStatus, KTabs, KTiming, KNeedsPanel, KRow, KGroup, KEmpty, KSwitch } from "./kit/index.js";

const css = readFileSync(join(import.meta.dirname, "tailwind.css"), "utf8");
/** The preflight rules: every line of tailwind.css that resets bare elements inside a rebuilt view. */
const rules = css.split("\n").filter(line => line.startsWith("[data-view] ") && line.includes(":not(.so-native-region *)"));
const KIT = ":where(:not(";
/** What every reset leaves alone: the selectors inside its `:where(:not(…))`. (happy-dom can't match a complex selector
 * inside :not, so each entry is matched on its own: an element is left alone when it matches any of them.) */
const owned = (rule: string): string[] => {
  const at = rule.indexOf(KIT);
  if (at < 0) return [];
  let depth = 0, i = at + KIT.length;
  for (; i < rule.length; i++) { if (rule[i] === "(") depth++; else if (rule[i] === ")") { if (depth === 0) break; depth--; } }
  return splitTop(rule.slice(at + KIT.length, i));
};
function splitTop(list: string): string[] {
  const out: string[] = []; let depth = 0, start = 0;
  for (let i = 0; i < list.length; i++) {
    if (list[i] === "(") depth++; else if (list[i] === ")") depth--;
    else if (list[i] === "," && depth === 0) { out.push(list.slice(start, i).trim()); start = i + 1; }
  }
  return [...out, list.slice(start).trim()];
}
const spared = (element: Element): boolean => owned(rules[0]!).some(selector => element.matches(selector));

async function view(node: ReactNode): Promise<HTMLElement> {
  document.body.innerHTML = '<div data-view="test"></div>';
  const host = document.querySelector<HTMLElement>("[data-view]")!;
  await act(async () => { createRoot(host).render(node); });
  return host;
}

test("no element of a kit piece gets the workspace reset; page content inside a kit container still does", async () => {
  // Every reset leaves the same set alone.
  expect(rules.length).toBeGreaterThan(8);
  for (const rule of rules) expect(owned(rule), rule).toEqual(owned(rules[0]!));
  const noop = () => {};
  const host = await view(createElement("div", null,
    createElement(KPageHeader, { title: "Tasks", ctx: "payments-api" }),
    createElement(KGroup, { label: "Running" }),
    createElement(KRow, { href: "#", chip: createElement(KStatus, { status: "running" }), title: "Harden retries", desc: "Step 2 of 4" }),
    createElement(KTabs, { label: "Task", current: "plan", items: [{ key: "plan", label: "Plan" }, { key: "activity", label: "Activity" }], onChange: noop }),
    createElement(KSeg, { label: "Status", current: "all", items: [{ key: "all", label: "All" }, { key: "needs", label: "Needs you" }], onChange: noop }),
    createElement(KDoc, null,
      createElement(KDocHeader, { title: "Fix payout rounding", meta: "payments-api", back: ["#", "Tasks"] }),
      createElement(KDisclose, { summary: "Details" }, "More"),
      createElement(KFacts, { rows: [["Project", "payments-api"]] }),
      createElement(KSlots, { status: createElement("h2", null, "Plan ready"), text: "Approving starts the build.", acts: null, terms: "Asks for your password." }),
      createElement(KNeedsPanel, { items: [{ title: "Spend limit reached", text: "New work waits." }] }),
      createElement(KTiming, { rows: [{ name: "Install", st: "ok", start: 0, dur: 38 }] }),
      createElement(KFormRow, { label: "Plan first", hint: "Read code first." }, createElement(KSwitch, { label: "Plan first", on: true, onChange: noop })),
      createElement(KRadios, { name: "role", legend: "Role", current: "a", items: [{ value: "a", label: "Can view", text: "Read work." }], onChange: noop }),
      createElement(KEmpty, { title: "No flows yet.", text: "A flow repeats a task." }),
      createElement(KComposer, { id: "ask", label: "Ask", value: "", onChange: noop, onSend: noop, project: { current: "payments-api", items: ["payments-api"] } }),
      createElement("button", { id: "page-content", type: "button" }, "Page button")),
    createElement(KSettingsShell, { group: "approval", title: "Policy", lead: "Limits.", sub: true }, createElement("p", { id: "settings-content" }, "Body")),
  ));
  const pageContent = new Set(["page-content", "settings-content"]);
  const kit = Array.from(host.querySelectorAll<HTMLElement>("*")).filter(element => !pageContent.has(element.id) && !element.closest("svg") && element !== host.firstElementChild);
  expect(kit.length).toBeGreaterThan(80);
  const stripped = kit.filter(element => !spared(element)).map(element => `${element.tagName.toLowerCase()}.${element.className} in .${element.parentElement?.className}`);
  expect(stripped).toEqual([]);
  // Page content still starts from the workspace's clean slate.
  expect(spared(host.querySelector("#page-content")!)).toBe(false);
  expect(spared(host.querySelector("#settings-content")!)).toBe(false);
});
