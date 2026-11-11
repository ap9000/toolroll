// @vitest-environment happy-dom
/**
 * The approve control acts only on a press a person made (kit/k-approve.tsx pressedByPerson): a click a script
 * dispatched approves nothing in the one-click mode and opens no password popover in the password mode; a press the
 * browser raised does both. The server proves the person again either way.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { KApprove, pressedByPerson } from "./kit/index.js";

let root: Root;
let box: HTMLElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  box = document.createElement("div");
  document.body.append(box);
  root = createRoot(box);
});
afterEach(() => { act(() => root.unmount()); box.remove(); });

/** What every browser says of a click: `isTrusted` false for `button.click()` and a dispatched event, true for a press. */
const click = (trusted: boolean) => Object.defineProperty(new MouseEvent("click", { bubbles: true, cancelable: true }), "isTrusted", { value: trusted });
const button = () => box.querySelector<HTMLButtonElement>("button[data-ink-approve]")!;

test("pressedByPerson: only a click the browser says a script made is not a person's", () => {
  expect(pressedByPerson({ nativeEvent: { isTrusted: false } })).toBe(false);
  expect(pressedByPerson({ nativeEvent: { isTrusted: true } })).toBe(true);
  expect(pressedByPerson({ nativeEvent: {} })).toBe(true);
});

test("one click: a script's click approves nothing and runs no check; a person's press approves once", async () => {
  const onApprove = vi.fn(async () => null);
  const check = vi.fn(() => true);
  await act(async () => { root.render(createElement(KApprove, { kind: "standard", facts: { passwordless: true, remembered: false }, label: "Approve", terms: "No password needed.", onApprove, check })); });
  await act(async () => { button().dispatchEvent(click(false)); });
  expect(check).not.toHaveBeenCalled();
  expect(onApprove).not.toHaveBeenCalled();
  await act(async () => { button().dispatchEvent(click(true)); });
  expect(check).toHaveBeenCalledTimes(1);
  expect(onApprove).toHaveBeenCalledTimes(1);
  expect(onApprove).toHaveBeenCalledWith(null, "passwordless");
});

test("password: a script's click opens no password popover; a person's press opens it and approves nothing by itself", async () => {
  const onApprove = vi.fn(async () => null);
  await act(async () => { root.render(createElement(KApprove, { kind: "standard", facts: { passwordless: false, remembered: false }, label: "Approve", terms: "Asks for your password.", onApprove })); });
  await act(async () => { button().dispatchEvent(click(false)); });
  expect(document.querySelector('input[type="password"]')).toBeNull();
  await act(async () => { button().dispatchEvent(click(true)); });
  expect(document.querySelector('input[type="password"]')).not.toBeNull();
  expect(onApprove).not.toHaveBeenCalled();
});
