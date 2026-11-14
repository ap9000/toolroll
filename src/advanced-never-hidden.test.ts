/**
 * Settings → Advanced off hides entry points only (the eight plan, W4 v2/v3). The safety rule: whatever the switch, a
 * person still sees what waits on them, every active safety setting's state and its off switch (Passwordless on,
 * provider sign-in set up, an active operating mode, local mode, API tokens and browser sessions, a fallback chain set,
 * commands in the live view), and Settings → Advanced lists every advanced page. Each row here is one of those.
 */
import { describe, expect, test } from "vitest";
import { ADVANCED_PAGES } from "./advanced-view.js";
import { browserNavigationOf } from "./browser-workspace.js";
import { html, htmlString, joinHtml, type Html } from "./html.js";
import { projectSettingsHtml } from "./project-delete-ui.js";
import { requestContext } from "./server/request-context.js";
import { settingsRows, workToolRows } from "./server/chrome.js";
import { accessGroup, approvalGroup, settingsGroupPage, settingsHub, type SettingsFacts } from "./settings-groups-ui.js";
import { generalSections, renderArea, type SectionPerson } from "./server/settings-sections.js";

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
    // Local mode lives on General now (settings plan F0); People and sign-in keeps its old #local-mode, leading there.
    ["enabled local mode, leading to its home", facts({ local: { owner: false, passwordSet: true, canTurnOff: true } }), "href=\"/settings/general?section=local-mode\""],
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
    expect(hub).toContain("Nothing is taking work");
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

/** General as an operator (or another person) sees it, with the switch as given; `open` asks for the Advanced detail. */
const OPERATOR: SectionPerson = { name: "alex", via: "cookie", role: "approver", authority: "full", operator: true, restricted: false, installation: true, passwordSet: true,
  principal: { caller: "cookie", capability: "act", viewer: false, token: false }, unscopedConsole: false };
const general = (advanced: boolean, options: { person?: SectionPerson; open?: boolean; localMode?: boolean } = {}) => render(advanced, () => joinHtml(renderArea("general",
  generalSections({ updatesVersion: () => null, packageVersion: "0.0.0", firstResult: () => null, passwordless: () => false, localModeOn: () => options.localMode === true }),
  { person: options.person ?? OPERATOR, project: null, now: new Date(), prefs: { theme: "system", accent: "#000000", advanced } },
  { section: options.open === true ? "advanced" : null, open: options.open === true }).sections));

describe("Settings → General → Show advanced features (Settings → Advanced, retired)", () => {
  test("the switch always; every advanced page whatever the switch, on request; operator-only pages only to an operator", () => {
    for (const on of [false, true]) {
      const page = general(on, { open: true });
      for (const one of ADVANCED_PAGES) expect(page).toContain(`href="${one.href}"`);
      expect(page).toContain("action=\"/settings/advanced\"");
      expect(page).toContain(`name="advanced" value="${on ? "off" : "on"}"`);
      // Not asked: the summary offers the list instead of carrying it.
      expect(general(on)).toContain("href=\"/settings/general?section=advanced&amp;open=1#advanced\"");
      expect(general(on)).not.toContain("href=\"/flows\"");
    }
    const viewer = /<section class="k-ssec" id="advanced"[\s\S]*?<\/section>/.exec(general(false, { open: true, person: { ...OPERATOR, name: "vic", role: "viewer", operator: false } }))![0];
    for (const one of ADVANCED_PAGES) expect(viewer.includes(`href="${one.href}"`)).toBe(one.operator !== true);
  });
  test("enabled local mode keeps its off switch with Advanced off: General leads to its change document", () => {
    expect(general(false, { localMode: true })).toContain("href=\"/settings/change/local-mode\"");
    expect(general(false, { localMode: false })).not.toContain("/settings/change/local-mode");
  });
  test("the overview says where the switch is; Spend leaves the menu while off", () => {
    const off = render(false, () => settingsGroupPage("agents", facts()));
    expect(off).not.toContain("href=\"/spend\"><span class=\"k-nav-l\">Spend");
    expect(off).not.toContain("href=\"/settings/advanced\"");
    const hub = render(false, () => settingsHub(facts()));
    expect(hub).toContain("advanced features off");
    expect(hub).not.toContain("href=\"/spend\"");
    expect(render(true, () => settingsHub(facts({}, true)))).toContain("href=\"/spend\"");
  });
});
