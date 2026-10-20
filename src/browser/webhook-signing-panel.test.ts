// @vitest-environment happy-dom
/**
 * v126: a ready Sentry or Vercel webhook's secret is replaced through the panel's own controls (the Signing box: the
 * secret, the password, Replace secret). The view is the real one for a real store, and the panel's request is
 * answered by the real save; afterwards the old secret proves nothing and the new one does.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createHmac } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "../store.js";
import { flowFromSteps } from "../flows.js";
import { addFlowTriggerTo, receiveFlowHook, saveSigningSecret, setFlowHookScope } from "../flow-triggers.js";
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
  vi.spyOn(window, "matchMedia").mockImplementation(query => ({ matches: false, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() }) as unknown as MediaQueryList);
  dir = realpathSync(mkdtempSync(join(tmpdir(), "so-signing-panel-")));
  store = openStore(join(dir, "orders.db"));
  flow = store.createFlow({ repo: REPO, name: "Errors", by: "alex", definitionJson: JSON.stringify(flowFromSteps([{ title: "Inbox", kind: "inbox" }], null)) }, T0);
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null; vi.restoreAllMocks(); vi.unstubAllGlobals();
  store.close(); rmSync(dir, { recursive: true, force: true });
});

const viewNow = () => flowView(store, store.getFlow(flow)!, { name: "alex", approver: true }, null, { dir, repos: [REPO] });
/** Typed as a person types: React hears the input event. */
function type(input: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

test.each([
  { sender: "sentry", settings: { project: "web" }, first: "c0ffee".repeat(10) + "abcd", next: "beef".repeat(16), header: "sentry-hook-signature", algorithm: "sha256" },
  { sender: "vercel", settings: { project: "prj_1", team: "team_1" }, first: "VercelSecret0123456789", next: "VercelRotated987654321", header: "x-vercel-signature", algorithm: "sha1" },
])("a ready $sender webhook's secret is replaced through the panel, and the old one then proves nothing", async ({ sender, settings, first, next, header, algorithm }) => {
  const made = addFlowTriggerTo(store, store.getFlow(flow)!, { kind: "webhook", sender, ...settings }, "alex", T0, dir);
  if (!made.ok) throw new Error(made.message);
  const id = made.id, token = made.reveal!.path.slice("/hooks/flow/".length);
  if (!saveSigningSecret(store, store.getFlowTrigger(id)!, first, T0, dir).ok) throw new Error("first secret");
  const deliver = (secret: string, body: string) => receiveFlowHook(store, token, { headers: { [header]: [createHmac(algorithm, secret).update(body).digest("hex")] }, body: Buffer.from(body) }, dir, T0);
  expect(deliver(first, '{"n":1}').status).toBe(202);

  // The console, for the panel's one request: the real save, behind the password.
  const posted: { path: string; fields: Record<string, string> }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (path: string, init: { body: URLSearchParams }) => {
    const fields = Object.fromEntries(init.body.entries());
    posted.push({ path, fields });
    const saved = fields["password"] === "correct horse" ? saveSigningSecret(store, store.getFlowTrigger(id)!, fields["secret"] ?? "", T0, dir) : { ok: false as const, message: "Enter your Toolroll password to save a secret." };
    return { ok: saved.ok, json: async () => saved.ok ? { ok: true, said: saved.said, view: viewNow() } : { ok: false, said: saved.message } };
  }));

  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(createElement(FlowView, { view: viewNow(), csrf: "fixture" })));
  await act(async () => document.querySelector<HTMLButtonElement>("[data-open-triggers]")!.click());
  const box = () => document.querySelector(`[data-trigger-row="${id}"] [data-trigger-signing]`)!;
  expect(box()).not.toBeNull();
  // Ready already, it still offers the secret — as a replacement.
  expect(box().textContent).toContain("Replace");
  const replace = () => [...box().querySelectorAll<HTMLButtonElement>("button")].find(one => one.textContent === "Replace secret")!;
  expect(replace().disabled).toBe(true);
  await act(async () => type(box().querySelector<HTMLInputElement>("[data-trigger-secret]")!, next));
  await act(async () => type(box().querySelector<HTMLInputElement>('input[autocomplete="current-password"]')!, "correct horse"));
  expect(replace().disabled).toBe(false);
  await act(async () => replace().click());

  expect(posted).toEqual([{ path: `/flows/${flow}/triggers/${id}/secret`, fields: { csrf: "fixture", secret: next, password: "correct horse" } }]);
  expect(deliver(first, '{"n":2}')).toEqual({ status: 401, said: "Signature doesn't match." });
  expect(deliver(next, '{"n":2}').status).toBe(202);
  // The panel cleared what was typed: a secret isn't left in the form.
  expect(box().querySelector<HTMLInputElement>("[data-trigger-secret]")!.value).toBe("");
});

test("a Vercel webhook's project is set through the Signing box, behind the password", async () => {
  const made = addFlowTriggerTo(store, store.getFlow(flow)!, { kind: "webhook", sender: "vercel" }, "alex", T0, dir);
  if (!made.ok) throw new Error(made.message);
  const id = made.id;
  const posted: { path: string; fields: Record<string, string> }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (path: string, init: { body: URLSearchParams }) => {
    const fields = Object.fromEntries(init.body.entries());
    posted.push({ path, fields });
    const scoped = setFlowHookScope(store, store.getFlowTrigger(id)!, { project: fields["project"], team: fields["team"] }, "alex", T0);
    return { ok: scoped.ok, json: async () => scoped.ok ? { ok: true, said: scoped.said, view: viewNow() } : { ok: false, said: scoped.message } };
  }));
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(createElement(FlowView, { view: viewNow(), csrf: "fixture" })));
  await act(async () => document.querySelector<HTMLButtonElement>("[data-open-triggers]")!.click());
  const box = () => document.querySelector(`[data-trigger-row="${id}"] [data-trigger-signing]`)!;
  expect(box().querySelector("[data-trigger-save-scope]")).toBeNull();
  await act(async () => type(box().querySelector<HTMLInputElement>("[data-trigger-project]")!, "prj_1"));
  await act(async () => type(box().querySelector<HTMLInputElement>('input[autocomplete="current-password"]')!, "correct horse"));
  await act(async () => box().querySelector<HTMLButtonElement>("[data-trigger-save-scope]")!.click());
  expect(posted).toEqual([{ path: `/flows/${flow}/triggers/${id}/scope`, fields: { csrf: "fixture", project: "prj_1", team: "", password: "correct horse" } }]);
  expect(store.getFlowTrigger(id)!.configJson).toContain('"project":"prj_1"');
});
