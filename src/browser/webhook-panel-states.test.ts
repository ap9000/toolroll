// @vitest-environment happy-dom
/**
 * v126: the webhook rows of a flow's Triggers panel in each state they can be in, on a desktop and on a phone, from the
 * real view of a real store: not set up, unsigned, unscoped, ready, deliveries turned away, a long source link on a
 * card, and a pasted secret of the wrong shape refused in words.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "../store.js";
import { flowFromSteps } from "../flows.js";
import { addFlowTriggerTo, saveSigningSecret } from "../flow-triggers.js";
import { flowView } from "../flows-ui.js";
import { FlowView } from "./views/flow-view.js";

const T0 = new Date("2026-10-19T12:00:00.000Z");
const REPO = "/test/shop";
class QuietStream extends EventTarget { static CLOSED = 2; readyState = 1; close() { this.readyState = 2; } }

let dir: string, store: Store, flow: number, root: Root | null = null;
beforeEach(() => {
  document.body.innerHTML = "";
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("EventSource", QuietStream);
  dir = realpathSync(mkdtempSync(join(tmpdir(), "so-panel-states-")));
  store = openStore(join(dir, "orders.db"));
  flow = store.createFlow({ repo: REPO, name: "Intake", by: "alex", definitionJson: JSON.stringify(flowFromSteps([{ title: "Inbox", kind: "inbox" }], null)) }, T0);
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null; vi.restoreAllMocks(); vi.unstubAllGlobals();
  store.close(); rmSync(dir, { recursive: true, force: true });
});

const add = (settings: Record<string, unknown>) => {
  const made = addFlowTriggerTo(store, store.getFlow(flow)!, { kind: "webhook", ...settings }, "alex", T0, dir);
  if (!made.ok) throw new Error(made.message);
  return made.id;
};
async function open(phone: boolean) {
  vi.spyOn(window, "matchMedia").mockImplementation(query => ({ matches: phone && query === "(max-width: 767px)", media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() }) as unknown as MediaQueryList);
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(createElement(FlowView, { view: flowView(store, store.getFlow(flow)!, { name: "alex", approver: true }, null, { dir, repos: [REPO] }), csrf: "fixture" })));
  // A desktop opens the Triggers panel; a phone lists its triggers on the page.
  if (!phone) await act(async () => document.querySelector<HTMLButtonElement>("[data-open-triggers]")!.click());
}
const row = (id: number) => document.querySelector(`[data-trigger-row="${id}"]`)!;

describe.each([false, true])("on a %s", phone => {
  test(`each webhook says plainly what it needs (phone=${phone})`, async () => {
    const unsigned = add({ title: "Open" });
    const standard = add({ sender: "standard" });
    const sentry = add({ sender: "sentry" });
    const unscoped = add({ sender: "sentry" });
    saveSigningSecret(store, store.getFlowTrigger(unscoped)!, "ab".repeat(32), T0, dir);
    const ready = add({ sender: "vercel", project: "prj_1" });
    saveSigningSecret(store, store.getFlowTrigger(ready)!, "A1b2C3d4E5f6G7h8", T0, dir);
    const dropped = add({ sender: "sentry", project: "web" });
    store.noteFlowDeliveryDropped(dropped, T0);
    store.noteFlowDeliveryDropped(dropped, T0);
    await open(phone);

    expect(row(unsigned).querySelector("[data-trigger-signing-warning]")!.textContent).toContain("Unsigned: anyone with its address can add cards.");
    expect(row(standard).querySelector("[data-trigger-signing-warning]")!.textContent).toContain("Not set up: its deliveries are refused until it is set up.");
    if (!phone) expect(row(standard).querySelector("[data-trigger-setup]")!.textContent).toBe("Set up");
    // Not set up comes first: an unset secret refuses everything, whatever its scope.
    expect(row(sentry).querySelector("[data-trigger-signing-warning]")!.textContent).toContain("Not set up: its deliveries are refused until Sentry's secret is pasted");
    expect(row(unscoped).querySelector("[data-trigger-signing-warning]")!.textContent).toContain("Any Sentry project this secret covers can add cards.");
    expect(row(sentry).querySelector("[data-trigger-reader-note]")!.textContent).toContain("Reader unverified");
    // Ready and scoped: no warning; on a desktop the Signing box starts closed, its secret still replaceable inside.
    expect(row(ready).querySelector("[data-trigger-signing-warning]")).toBeNull();
    if (!phone) {
      expect(row(ready).querySelector<HTMLDetailsElement>("[data-trigger-signing]")!.open).toBe(false);
      expect(row(ready).querySelector("[data-trigger-secret]")).not.toBeNull();
    }
    // Turned away: counted, with what may still arrive, and a way to clear it.
    const banner = row(dropped).querySelector("[data-trigger-dropped]")!;
    expect(banner.textContent).toContain("2 deliveries were turned away");
    expect(banner.textContent).toContain("Sentry may retry a refused delivery");
    expect([...banner.querySelectorAll("button")].map(one => one.textContent)).toEqual(["Clear"]);
  });
});

test("a pasted secret of the wrong shape is refused in words, and nothing is saved", async () => {
  const sentry = add({ sender: "sentry" });
  vi.stubGlobal("fetch", vi.fn(async (_path: string, init: { body: URLSearchParams }) => {
    const saved = saveSigningSecret(store, store.getFlowTrigger(sentry)!, init.body.get("secret") ?? "", T0, dir);
    return { ok: saved.ok, json: async () => saved.ok ? { ok: true, said: saved.said } : { ok: false, said: saved.message } };
  }));
  await open(false);
  const box = row(sentry).querySelector("[data-trigger-signing]")!;
  const type = (input: HTMLInputElement, value: string) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); };
  await act(async () => type(box.querySelector<HTMLInputElement>("[data-trigger-secret]")!, "not a secret"));
  await act(async () => type(box.querySelector<HTMLInputElement>('input[autocomplete="current-password"]')!, "correct horse"));
  await act(async () => [...box.querySelectorAll<HTMLButtonElement>("button")].find(one => one.textContent === "Save secret")!.click());
  // The panel sent it; the console refused it in words (shown as a toast) and saved nothing.
  expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  expect(saveSigningSecret(store, store.getFlowTrigger(sentry)!, "not a secret", T0, dir)).toMatchObject({ ok: false, message: expect.stringContaining("Paste the Client Secret exactly as Sentry shows it") });
  expect(store.getFlowTrigger(sentry)!.hookCredential).toBe("");
});

test("a card from a signed webhook says how it was proved and where its link goes, however long the link", async () => {
  const url = `https://acme.sentry.io/organizations/acme/issues/1170820242/events/${"e".repeat(1800)}/`;
  store.addFlowCard({ flow, title: "TypeError in roundTotal", description: null, stage: JSON.parse(store.getFlow(flow)!.definitionJson).start, by: "Webhook", byKind: "automation",
    source: { kind: "sentry", label: "Sentry issue", url, verified: "sentry", external: { id: "1170820242", url }, receipt: "v3:sentry:id:1170820242" } }, T0);
  vi.spyOn(window, "matchMedia").mockImplementation(query => ({ matches: false, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() }) as unknown as MediaQueryList);
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(createElement(FlowView, { view: flowView(store, store.getFlow(flow)!, { name: "alex", approver: true }, null, { dir, repos: [REPO] }), csrf: "fixture" })));
  const card = [...document.querySelectorAll<HTMLButtonElement>("button")].find(one => one.textContent?.startsWith("TypeError in roundTotal"))!;
  await act(async () => card.click());
  const line = [...document.querySelectorAll("p")].find(one => one.textContent?.startsWith("From Sentry issue"))!;
  // The link shows where it goes — host and path, its middle elided when long — beside what it is.
  expect(line.textContent).toMatch(/^From Sentry issue \(signed by Sentry\) · acme\.sentry\.io\/organizations\/acme\/issues\/1…e+\/$/);
  const link = line.querySelector("a")!;
  expect(link.getAttribute("href")).toBe(url);
  expect(link.getAttribute("rel")).toBe("noopener noreferrer");
});

test("Clear takes the turned-away count off for good", async () => {
  const dropped = add({ sender: "sentry", project: "web" });
  store.noteFlowDeliveryDropped(dropped, T0);
  vi.stubGlobal("fetch", vi.fn(async (path: string) => {
    expect(path).toBe(`/flows/${flow}/triggers/${dropped}/dropped`);
    store.clearFlowDeliveriesDropped(dropped);
    return { ok: true, json: async () => ({ ok: true, said: "Cleared.", view: flowView(store, store.getFlow(flow)!, { name: "alex", approver: true }, null, { dir, repos: [REPO] }) }) };
  }));
  await open(false);
  await act(async () => [...row(dropped).querySelector("[data-trigger-dropped]")!.querySelectorAll<HTMLButtonElement>("button")].find(one => one.textContent === "Clear")!.click());
  expect(store.getFlowTrigger(dropped)).toMatchObject({ droppedCount: 0, droppedSince: null });
  expect(row(dropped).querySelector("[data-trigger-dropped]")).toBeNull();
});

test("on a phone: a long trigger title and a wrong secret are handled the same way", async () => {
  const sentry = add({ sender: "sentry", title: "T".repeat(120) });
  vi.stubGlobal("fetch", vi.fn(async (_path: string, init: { body: URLSearchParams }) => {
    const saved = saveSigningSecret(store, store.getFlowTrigger(sentry)!, init.body.get("secret") ?? "", T0, dir);
    return { ok: saved.ok, json: async () => saved.ok ? { ok: true, said: saved.said } : { ok: false, said: saved.message } };
  }));
  await open(true);
  expect(row(sentry).textContent).toContain("Sentry");
  const box = row(sentry).querySelector("[data-trigger-signing]")!;
  const type = (input: HTMLInputElement, value: string) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); };
  await act(async () => type(box.querySelector<HTMLInputElement>("[data-trigger-secret]")!, "not a secret"));
  await act(async () => type(box.querySelector<HTMLInputElement>('input[autocomplete="current-password"]')!, "correct horse"));
  await act(async () => [...box.querySelectorAll<HTMLButtonElement>("button")].find(one => one.textContent === "Save secret")!.click());
  expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  expect(store.getFlowTrigger(sentry)!.hookCredential).toBe("");
});
