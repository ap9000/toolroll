/** Settings revamp S4, first-run dead ends: a task with no builder leads to Start a builder on /system (the command as
 * text to select), and /system names each model once. */
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { OWNER, ROOT } from "./fixture.mjs";

export const about = "No builder: Connect a builder → Start a builder; /system wording and model names";
export const fixture = "lived-in";

export const pages = [
  { name: "system", path: "/system" },
];

const dist = path => import(pathToFileURL(join(ROOT, "dist", path)).href);

/** Approves the fixture's waiting plan through the store's own door, so the task now waits only for a builder. */
async function approveWaiting(store) {
  const { approve } = await dist("scope.js");
  const scope = store.getScope("waiting-1");
  if (scope === null) throw new Error("fixture: no waiting plan");
  const answer = approve(store, "waiting-1", OWNER.name, new Date(), scope.digest, OWNER.password);
  if (answer.ok === false && !/already/i.test(String(answer.reason ?? ""))) throw new Error(`fixture: approve: ${answer.reason}`);
}

export const actions = [{
  name: "connect-a-builder",
  async run({ page, fixture, goto, shot, probes }) {
    await approveWaiting(fixture.store);
    await goto("/t/waiting-1");
    await shot("task");
    const findings = [...await probes.oneH1(page)];
    const link = page.locator("a[data-primary-action]", { hasText: "Connect a builder" }).first();
    if (await link.count() === 0) return [...findings, { probe: "load", detail: "the task shows no Connect a builder action" }];
    const href = await link.getAttribute("href");
    if (href !== "/system#builder") findings.push({ probe: "load", detail: `Connect a builder goes to ${href}, not /system#builder` });
    await Promise.all([page.waitForLoadState("load"), link.click()]);
    await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});
    await page.locator("#builder").scrollIntoViewIfNeeded().catch(() => {});
    await shot("start-a-builder");
    if (await page.locator("#builder code", { hasText: "toolroll up" }).count() === 0) findings.push({ probe: "load", detail: "Start a builder doesn't show toolroll up" });
    return [...findings, ...await probes.oneH1(page), ...await probes.noOverflow(page)];
  },
}];
