// @vitest-environment happy-dom
/** A running attempt's files on this computer (docs/plans/agents-cockpit.md phase E): Show in Finder is offered only
 * where it can work, and a clipboard that refuses or isn't there says so, with the command shown to select by hand. */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { CheckoutActions } from "./views/agents-view.js";

let root: Root | null = null, host: HTMLElement;
beforeEach(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; host = document.createElement("div"); document.body.append(host); });
afterEach(async () => { vi.restoreAllMocks(); await act(async () => root?.unmount()); root = null; host.remove(); });
const render = (reveal: string | null) => act(() => { root = createRoot(host); root.render(createElement(CheckoutActions, { checkout: { path: "/pool/wt-1", cd: "cd '/pool/wt-1'", reveal } })); });
const click = (selector: string) => act(async () => { host.querySelector<HTMLElement>(selector)!.click(); await Promise.resolve(); });

test("Show in Finder appears only with a reveal address; the path and the command always", () => {
  render("/r/7/reveal");
  expect(host.querySelector("[data-agent-reveal]")?.getAttribute("action")).toBe("/r/7/reveal");
  act(() => root?.render(createElement(CheckoutActions, { checkout: { path: "/pool/wt-1", cd: "cd '/pool/wt-1'", reveal: null } })));
  expect(host.querySelector("[data-agent-reveal]")).toBeNull();
  expect(host.querySelector("[data-agent-checkout-path]")?.textContent).toBe("/pool/wt-1");
  expect(host.querySelector("[data-agent-copy-cd]")).not.toBeNull();
});

test("a refused clipboard, or none, says so and shows the command to copy by hand", async () => {
  render(null);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: () => Promise.reject(new Error("denied")) } });
  await click("[data-agent-copy-cd]");
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(host.querySelector("[data-agent-copy-failed]")?.textContent).toContain("cd '/pool/wt-1'");
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
  await click("[data-agent-copy-cd]");
  expect(host.querySelector("[data-agent-copy-failed]")).not.toBeNull();
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: () => Promise.resolve() } });
  await click("[data-agent-copy-cd]");
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(host.querySelector("[data-agent-copy-cd]")?.textContent).toBe("Copied");
  expect(host.querySelector("[data-agent-copy-failed]")).toBeNull();
});
