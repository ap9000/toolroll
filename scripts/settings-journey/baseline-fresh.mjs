/** Wave-0 baseline on a fresh installation (Settings revamp S1): the first-account page, with and without
 * JavaScript, and a wrong setup code, the forced validation error the field-error probe checks. S3 owns this page. */
import { SETUP_CODE } from "./fixture.mjs";

export const about = "The first-account page on a fresh installation";
export const fixture = "fresh";

export const pages = [{ name: "first-account", path: "/", as: "anon", noJs: true }];

export const actions = [{
  name: "first-account-wrong-code",
  as: "anon",
  path: "/",
  async run({ page, probes, shot }) {
    await page.fill("input[name=code]", SETUP_CODE.split("").reverse().join(""));
    await page.fill("input[name=name]", "alex");
    await page.fill("input[name=password]", "correct-horse-1");
    await Promise.all([page.waitForLoadState("load"), page.click("button[type=submit]")]);
    await shot("error");
    return [...await probes.expectFieldError(page), ...await probes.oneH1(page)];
  },
}];
