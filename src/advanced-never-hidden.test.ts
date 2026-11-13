/**
 * Settings → Advanced off hides entry points only (the eight plan, W4 v2/v3). The safety rule: whatever the switch, a
 * person still sees what waits on them, every active safety setting's state and its off switch (Passwordless on,
 * provider sign-in set up, an active operating mode, local mode, API tokens and browser sessions, a fallback chain set,
 * commands in the live view), and Settings → Advanced lists every advanced page. Each row here is one of those.
 */
import { describe, expect, test } from "vitest";
import { ADVANCED_PAGES } from "./advanced-view.js";
import { browserNavigationOf } from "./browser-workspace.js";
import { html, htmlString, type Html } from "./html.js";
import { projectSettingsHtml } from "./project-delete-ui.js";
import { requestContext } from "./server/request-context.js";
import { settingsRows, workToolRows } from "./server/chrome.js";
import { accessGroup, advancedGroup, approvalGroup, settingsGroupPage, settingsHub, type SettingsFacts } from "./settings-groups-ui.js";

const render = (advanced: boolean, draw: () => Html): string => requestContext.run({ csrf: "c", returnTo: "/", advanced }, () => htmlString(draw()));
const facts = (over: Partial<SettingsFacts> = {}, on = false): SettingsFacts => ({
  name: "alex", approver: true, operator: true, browser: true, installation: true, said: null, problem: null, theme: "system", accent: "#000000",
  version: null, permission: null, quality: null, providers: null, workers: [], updates: null, firstResult: null, chat: null, messaging: null,
  push: null, digest: null, telegram: { state: "", current: "", delivery: null, failing: false }, email: null, phone: null, projects: [],
  people: null, passwordless: false, sso: null, access: { sessions: 2, tokens: 1 }, backup: null, local: null,
  advanced: { on, canChange: true }, ...over,
});
const holdings = { tasks: 0, versions: 0, runs: 0, evidence: 0, checkouts: 0, chats: 0, flows: 0, cards: 0, subagents: 0, budgets: 0, settings: 0 };

describe("with Advanced off, never hidden", () => {
  test.each([
    ["enabled Passwordless", facts({ passwordless: true }), "/settings/passwordless"],
    ["provider sign-in that is set up", facts({ sso: "Okta" }), "/settings/sign-in"],
    ["live browser sessions and active API tokens", facts(), "/settings/sessions"],
    ["enabled local mode and its off switch", facts({ local: { owner: false, passwordSet: true, canTurnOff: true } }), "/settings/local-mode/off"],
    ["who can get in", facts(), "href=\"/people\""],
  ])("%s", (_name, view, needle) => {
    expect(render(false, () => accessGroup(view, {}))).toContain(needle);
  });
  test("an active operating mode keeps its link (its terms and End it); Requirements always stays", () => {
    const page = (modeActive: boolean) => render(false, () => approvalGroup({ facts: { said: null, problem: null, permission: null, quality: null }, flags: {}, projects: [], chosen: "", rules: html``, mode: "shop: night shift", advanced: { on: false, modeActive } }));
    expect(page(true)).toContain("href=\"/mode\"");
    expect(page(true)).toContain("href=\"/caps\"");
    expect(page(false)).not.toContain("href=\"/mode\"");
    expect(page(false)).not.toContain("/settings/policy");
    expect(page(false)).toContain("href=\"/caps\"");
  });
  test("Policy keeps its link and what it is now while any restriction applies (or can't be read)", () => {
    const page = (policy: string | null) => render(false, () => approvalGroup({ facts: { said: null, problem: null, permission: null, quality: null }, flags: {}, projects: [], chosen: "", rules: html``, mode: "", advanced: { on: false, modeActive: false, policy } }));
    const restricted = page("Providers: Claude · models: any · tools: any · ceiling: Standard");
    expect(restricted).toContain("href=\"/settings/policy\"");
    expect(restricted).toContain("ceiling: Standard");
    expect(page(null)).not.toContain("/settings/policy");
  });
  test("what waits on this person in Settings", () => {
    const hub = render(false, () => settingsHub(facts({ workers: [], backup: { failed: true, words: "Failed today" } })));
    expect(hub).toContain("No builder is connected");
    expect(hub).toContain("The last backup failed");
  });
  test("a fallback chain that is set, and commands shown in the live view", () => {
    const view = (setting: boolean, commands: boolean) => projectSettingsHtml({ repo: "/r", name: "r", holdings, running: [], canDelete: false,
      fallback: { setting: setting ? { repo: "/r", entries: [{ provider: "codex", model: "gpt-5", authMode: "subscription" }], paidGrant: null, updatedBy: "alex", updatedAt: "2026-11-13" } : null, canChange: false },
      liveView: { commands, canChange: false }, codeMap: { on: true, enrollUntil: null, canEndHoldout: false, href: "/projects/r/map" } }, {});
    const set = render(false, () => view(true, true));
    expect(set).toContain("id=\"fallback\"");
    expect(set).toContain("Commands and their output show");
    const unset = render(false, () => view(false, false));
    expect(unset).not.toContain("id=\"fallback\"");
    expect(unset).not.toContain("Commands are hidden in the live view");
    expect(unset).not.toContain("id=\"code-map\"");
    expect(render(true, () => view(false, false))).toContain("id=\"fallback\"");
  });
  test("the rail keeps Home with its count, Chat, Tasks, Projects and Settings; pages of a hidden item sit under Settings", () => {
    const off = browserNavigationOf("/flows", null, 3, null, undefined, false);
    expect(off.map(one => one.label)).toEqual(["Home", "Chat", "Tasks", "Projects", "Settings"]);
    expect(off[0]).toMatchObject({ count: 3 });
    expect(off.find(one => one.label === "Settings")?.active).toBe(true);
    expect(browserNavigationOf("/", null, 0, null).map(one => one.label)).toEqual(["Home", "Chat", "Tasks", "Flows", "Agents", "Projects", "Settings"]);
    expect(settingsRows(false, true, false).map(one => one.key)).toEqual(["settings", "caps", "people", "system"]);
    expect(workToolRows(false, false, true, false).map(one => one.key)).not.toContain("spend");
  });
});

describe("Settings → Advanced", () => {
  test("lists every advanced page whatever the switch; operator-only pages only to an operator", () => {
    for (const on of [false, true]) {
      const page = render(on, () => advancedGroup(facts({}, on), {}));
      for (const one of ADVANCED_PAGES) expect(page).toContain(`href="${one.href}"`);
      expect(page).toContain("action=\"/settings/advanced\"");
      expect(page).toContain(`name="advanced" value="${on ? "off" : "on"}"`);
    }
    const viewer = render(false, () => advancedGroup(facts({ operator: false, approver: false }), {}));
    for (const one of ADVANCED_PAGES) expect(viewer.includes(`href="${one.href}"`)).toBe(one.operator !== true);
  });
  test("is in the Settings menu for everyone; Spend leaves it while off", () => {
    const off = render(false, () => settingsGroupPage("advanced", facts()));
    expect(off).toContain("href=\"/settings/advanced\"");
    expect(off).not.toContain("href=\"/spend\"><span class=\"k-nav-l\">Spend");
    const hub = render(false, () => settingsHub(facts()));
    expect(hub).toContain("/settings/advanced");
    expect(hub).not.toContain("href=\"/spend\"");
    expect(render(true, () => settingsHub(facts({}, true)))).toContain("href=\"/spend\"");
  });
});
