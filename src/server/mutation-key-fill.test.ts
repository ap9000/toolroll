// @vitest-environment happy-dom
/** The page's key fill (easy-start C2): a same-origin POST form's data carries the key, even when one of the form's
 * controls is named "method" or "action" (the skill form's <select name="method"> shadowed form.method in a real
 * browser). happy-dom neither shadows nor fires `formdata`, so both are done here by hand. */
import { beforeAll, expect, test } from "vitest";
import { KEY_FILL_SCRIPT } from "./mutation-key.js";

const KEY = "c".repeat(64);

beforeAll(() => {
  localStorage.setItem("toolroll.key", JSON.stringify({ epoch: "e", key: KEY }));
  new Function(KEY_FILL_SCRIPT)();
});

/** The form's data as a browser's submit would build it, with `shadow` standing in for its named controls. */
function submitted(method: string, action: string, shadow: { method?: string; action?: string } = {}): string | null {
  document.body.textContent = "";
  const form = document.createElement("form");
  form.setAttribute("method", method);
  form.setAttribute("action", action);
  for (const [name, value] of Object.entries(shadow)) {
    const control = document.createElement("input");
    control.name = name;
    control.value = value;
    form.append(control);
    // As a browser does: the control named `name` hides the form's own property of that name.
    Object.defineProperty(form, name, { value: control, configurable: true });
  }
  document.body.append(form);
  const formData = new FormData();
  const event = new Event("formdata", { bubbles: true });
  Object.defineProperty(event, "formData", { value: formData });
  form.dispatchEvent(event);
  return formData.get("toolroll-key") as string | null;
}

test.each([
  ["a plain post form", "post", "/x", {}, KEY],
  ["a control named method", "post", "/settings/skills/import", { method: "paste" }, KEY],
  ["a control named action", "post", "/x", { action: "https://elsewhere.example/x" }, KEY],
  ["a get form whose control says post", "get", "/x", { method: "post" }, null],
  ["another origin, a control naming this one", "post", "https://elsewhere.example/x", { action: "/x" }, null],
] as const)("%s", (_name, method, action, shadow, expected) => {
  expect(submitted(method, action, shadow)).toBe(expected);
});
