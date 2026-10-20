/**
 * v126: a webhook's credentials when the secret store itself fails (docs/plans/webhook-tasks.md §1). The store is the
 * real one, with failures injected at its door: a secret that can't be removed is still never read again, and a secret
 * that can't be saved changes nothing — the working address and its secret stay exactly as they were. Two renewals from
 * the same reading: exactly one lands, and the address it gave out is the one that works.
 */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createHmac } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** What the next secret-store writes do: "ok", or fail when removing ("drop") or saving ("save"). */
const failing = vi.hoisted(() => ({ mode: "ok" as "ok" | "drop" | "save" }));
vi.mock("./tool-secret-store.js", async original => {
  const real = await original<typeof import("./tool-secret-store.js")>();
  return {
    ...real,
    writeHeldSecret: (state: string, name: string, file: readonly string[], value: string | null) => {
      if (failing.mode === "drop" && value === null) throw new real.SecretStoreError("The keychain refused to remove it.");
      if (failing.mode === "save" && value !== null) throw new real.SecretStoreError("The keychain refused to save it.");
      return real.writeHeldSecret(state, name, file, value);
    },
  };
});

const { openStore } = await import("./store.js");
const { flowFromSteps } = await import("./flows.js");
const { addFlowTriggerTo, readHookSecret, receiveFlowHook, renewFlowHook, saveSigningSecret, setUpFlowHook } = await import("./flow-triggers.js");
type Store = import("./store.js").Store;

const T0 = new Date("2026-10-19T12:00:00.000Z");
let dir: string, store: Store, flow: number;
beforeEach(() => {
  failing.mode = "ok";
  dir = realpathSync(mkdtempSync(join(tmpdir(), "so-hook-fail-")));
  store = openStore(join(dir, "orders.db"));
  flow = store.createFlow({ repo: "/test/shop", name: "Intake", by: "alex", definitionJson: JSON.stringify(flowFromSteps([{ title: "Inbox", kind: "inbox" }], null)) }, T0);
});
afterEach(() => { failing.mode = "ok"; store.close(); rmSync(dir, { recursive: true, force: true }); });

const tokenOf = (path: string) => path.slice("/hooks/flow/".length);
const trigger = (id: number) => store.getFlowTrigger(id)!;
const sign = (secret: string, body: string) => ({ "x-hub-signature-256": [`sha256=${createHmac("sha256", secret).update(body).digest("hex")}`] });
const ping = (token: string, secret: string) => receiveFlowHook(store, token, { headers: { "x-github-event": ["ping"], ...sign(secret, "{}") }, body: Buffer.from("{}") }, dir, T0);
const post = (token: string, secret: string, body: string) => receiveFlowHook(store, token, { headers: sign(secret, body), body: Buffer.from(body) }, dir, T0);
function github() {
  const made = addFlowTriggerTo(store, store.getFlow(flow)!, { kind: "github", repo: "acme/shop", watch: "issues", delivery: "webhook", from: "anyone" }, "alex", T0, dir);
  if (!made.ok) throw new Error(made.message);
  return { id: made.id, token: tokenOf(made.reveal!.path), secret: made.reveal!.secret! };
}
function signed() {
  const made = addFlowTriggerTo(store, store.getFlow(flow)!, { kind: "webhook", sender: "github-style" }, "alex", T0, dir);
  if (!made.ok) throw new Error(made.message);
  const setUp = setUpFlowHook(store, trigger(made.id), T0, dir);
  if (!setUp.ok) throw new Error(setUp.message);
  return { id: made.id, token: tokenOf(setUp.reveal!.path), secret: setUp.reveal!.secret! };
}

test("a replaced secret that can't be removed is still never read again", () => {
  const hook = signed();
  const old = trigger(hook.id).hookCredential;
  failing.mode = "drop";
  const replaced = setUpFlowHook(store, trigger(hook.id), T0, dir);
  if (!replaced.ok) throw new Error(replaced.message);
  failing.mode = "ok";
  // Its file is still there: removing it failed.
  expect(readHookSecret(dir, hook.id, old)).toBe(hook.secret);
  expect(post(hook.token, hook.secret, '{"title":"a"}')).toEqual({ status: 401, said: "Signature doesn't match." });
  expect(post(hook.token, replaced.reveal!.secret!, '{"title":"a"}')).toMatchObject({ status: 202 });
});

test("a secret that can't be saved changes nothing: Replace secret, a pasted secret, and GitHub's New address each leave the working pair as it was", () => {
  const hook = signed();
  const before = { credential: trigger(hook.id).hookCredential, hash: trigger(hook.id).hookHash };
  failing.mode = "save";
  expect(setUpFlowHook(store, trigger(hook.id), T0, dir)).toEqual({ ok: false, message: "The keychain refused to save it." });
  expect({ credential: trigger(hook.id).hookCredential, hash: trigger(hook.id).hookHash }).toEqual(before);
  failing.mode = "ok";
  expect(post(hook.token, hook.secret, '{"title":"still works"}')).toMatchObject({ status: 202 });

  const sentry = addFlowTriggerTo(store, store.getFlow(flow)!, { kind: "webhook", sender: "sentry" }, "alex", T0, dir);
  if (!sentry.ok) throw new Error(sentry.message);
  failing.mode = "save";
  expect(saveSigningSecret(store, trigger(sentry.id), "ab".repeat(32), T0, dir)).toEqual({ ok: false, message: "The keychain refused to save it." });
  expect(trigger(sentry.id).hookCredential).toBe("");

  failing.mode = "ok";
  const gh = github();
  failing.mode = "save";
  expect(renewFlowHook(store, trigger(gh.id), T0, dir)).toEqual({ ok: false, message: "The keychain refused to save it." });
  failing.mode = "ok";
  // The address it had, with the secret it had, still answers.
  expect(ping(gh.token, gh.secret)).toEqual({ status: 200, said: "Connected." });
});

test("two renewals from the same reading: exactly one lands, and the address it gave out is the one that works", () => {
  for (const make of [github, signed]) {
    const hook = make();
    const seenByA = trigger(hook.id), seenByB = trigger(hook.id);
    const a = renewFlowHook(store, seenByA, T0, dir);
    if (!a.ok) throw new Error(a.message);
    expect(renewFlowHook(store, seenByB, T0, dir)).toEqual({ ok: false, message: "That trigger changed meanwhile. Open it again." });
    const secret = a.reveal!.secret ?? hook.secret;
    // A's address works with its secret; the original address is gone.
    if (make === github) expect(ping(tokenOf(a.reveal!.path), secret)).toEqual({ status: 200, said: "Connected." });
    else expect(post(tokenOf(a.reveal!.path), secret, '{"title":"renewed"}')).toMatchObject({ status: 202 });
    expect(post(hook.token, secret, '{"title":"old address"}')).toEqual({ status: 404, said: "No such address." });
  }
});
