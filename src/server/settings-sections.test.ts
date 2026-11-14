/**
 * The settings section foundation (the eight settings plan v2 §2, slice F0): every section keeps its page's pinned
 * route policy; admission (read), data scope and action capability are decided before any loader runs, with zero
 * loader calls for a denied persona and the reads a viewer has today kept; one canonical project; the check a
 * session-bound act makes against the project its form was drawn for; change documents; retired addresses; the
 * script and proof inventories.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { htmlString, joinHtml, type Html } from "../html.js";
import { PROOF_INVENTORY } from "../settings-proofs.js";
import { HUB_ANCHORS } from "../settings-groups-ui.js";
import { loginReturn } from "./http.js";
import { requestContext } from "./request-context.js";
import { RETIRED_ROUTES, SETTINGS_RETIRED, settingsRetiredHref } from "./retired-routes.js";
import { holdsRole } from "./route-policy.js";
import { ROUTES } from "./route-table.js";
import { SCRIPT_INVENTORY } from "./settings-scripts.js";
import { CHANGE_DOCUMENTS, SETTINGS_SECTIONS, type SectionDeclaration, type SectionPolicy } from "./settings-section-table.js";
import { computersSections } from "./settings-computers.js";
import {
  PROJECT_NOT_AVAILABLE, admitSection, askedSection, changeDocument, generalSections, openProjectAgain, renderArea, resolveSettingsProject, sessionProjectCheck,
  type GeneralDeps, type SectionImpl, type SectionImpls, type SectionPerson,
} from "./settings-sections.js";

const render = <T>(run: () => T): T => requestContext.run({ csrf: "c-1", returnTo: "/settings/general" }, run);
const text = (parts: readonly Html[]): string => htmlString(joinHtml([...parts]));

// ---- the pinned policy ---------------------------------------------------------------------------------------------

/** The route rows the sections came from, as they were at 271c93e1 (independent of ROUTES: a change here is on purpose). */
const PINNED: Record<string, SectionPolicy> = {
  "settings.group-general": { callers: ["cookie", "bearer"], scope: "read", project: "session", limited: "unscoped", needsProject: false, role: "any", roleBrowser: false, viewer: false, local: "allow" },
  "settings.group-advanced": { callers: ["cookie", "bearer"], scope: "read", project: "session", limited: "unscoped", needsProject: false, role: "any", roleBrowser: false, viewer: false, local: "allow" },
  "settings.group-access": { callers: ["cookie", "bearer"], scope: "read", project: "session", limited: "unscoped", needsProject: false, role: "any", roleBrowser: false, viewer: false, local: "allow" },
  // Settings → Computers (F2): Start a builder admitted a project-limited person; /fleet (the computers) didn't.
  "start-builder": { callers: ["cookie", "bearer"], scope: "read", project: "session", limited: "unscoped", needsProject: false, role: "any", roleBrowser: false, viewer: false, local: "allow" },
  "fleet": { callers: ["cookie", "bearer"], scope: "read", project: "session", limited: "deny", needsProject: false, role: "any", roleBrowser: false, viewer: false, local: "allow" },
};
const policyOf = (row: (typeof ROUTES)[number]): SectionPolicy => ({ callers: row.callers, scope: row.scope, project: row.project, limited: row.limited, needsProject: row.needsProject,
  role: row.role, roleBrowser: row.roleBrowser, ...(row.roleRefusal === undefined ? {} : { roleRefusal: row.roleRefusal }), viewer: row.viewer, local: row.local });

describe("every section keeps the route policy of the page it came from", () => {
  test.each(SETTINGS_SECTIONS.map(one => [one.id, one] as const))("%s", (_id, section) => {
    expect(PINNED[section.pinnedFrom], section.pinnedFrom).toBeDefined();
    expect(section.policy).toEqual(PINNED[section.pinnedFrom]);
    // The row it came from still admits exactly so (a retired row admits as its target does).
    expect(policyOf(ROUTES.find(row => row.id === section.pinnedFrom)!)).toEqual(PINNED[section.pinnedFrom]);
  });
  test("each change document is one GET row carrying its section's policy, and nothing else is one", () => {
    const rows = ROUTES.filter(row => row.id.startsWith("settings.change."));
    expect(rows.map(row => row.id).sort()).toEqual(CHANGE_DOCUMENTS.map(one => `settings.change.${one.id}`).sort());
    for (const one of CHANGE_DOCUMENTS) {
      const row = rows.find(each => each.id === `settings.change.${one.id}`)!;
      expect([row.stage, row.method, row.sample, row.retired]).toEqual(["console", "GET", `/settings/change/${one.id}`, undefined]);
      expect(policyOf(row)).toEqual(one.section.policy);
      // Its form's proof row exists, and posts to a route of its own (the document never posts anywhere new).
      expect(PROOF_INVENTORY.find(proof => proof.id === one.proof)?.routes.length).toBeGreaterThan(0);
      expect(Object.keys(one.section.act)).toContain(one.act);
    }
  });
  test("ids are unique, and every section of the table has an implementation", () => {
    expect(new Set(SETTINGS_SECTIONS.map(one => one.id)).size).toBe(SETTINGS_SECTIONS.length);
    expect(new Set(CHANGE_DOCUMENTS.map(one => one.id)).size).toBe(CHANGE_DOCUMENTS.length);
    const general = generalSections(DEPS);
    expect(Object.keys(general).sort()).toEqual(SETTINGS_SECTIONS.filter(one => one.area === "general").map(one => one.id).sort());
    const computers = computersSections({} as never, { task: null, computer: null, drafts: {} });
    expect(Object.keys(computers).sort()).toEqual(SETTINGS_SECTIONS.filter(one => one.area === "computers").map(one => one.id).sort());
    expect([...new Set(SETTINGS_SECTIONS.map(one => one.area))].sort()).toEqual(["computers", "general"]);
  });
});

// ---- holdsRole: the console's rule, extracted ------------------------------------------------------------------------

test("holdsRole is the console's role rule exactly (dispatchConsole calls it; so does every section)", () => {
  // The rule as serve.ts wrote it inline at 271c93e1.
  const before = (route: { role: string; roleBrowser: boolean }, who: { via: string; role: string }, operator: boolean) =>
    route.role === "any" || ((!route.roleBrowser || who.via === "cookie") && (route.role === "approver" ? who.role === "approver" : operator));
  let cases = 0;
  for (const role of ["any", "approver", "operator"] as const) for (const roleBrowser of [false, true]) for (const via of ["cookie", "bearer"] as const)
    for (const who of ["approver", "viewer"] as const) for (const operator of [false, true]) {
      expect(holdsRole({ role, roleBrowser }, { name: "n", via, role: who }, () => operator), `${role} ${roleBrowser} ${via} ${who} ${operator}`).toBe(before({ role, roleBrowser }, { via, role: who }, operator));
      cases++;
    }
  expect(cases).toBe(48);
  expect(readFileSync(new URL("../serve.ts", import.meta.url), "utf8")).toContain("if (!holdsRole(route, who, name => store.isInstanceOperator(name))) {");
});

// ---- personas and the zero-loader matrix ---------------------------------------------------------------------------

const OPERATOR: SectionPerson = { name: "alex", via: "cookie", role: "approver", authority: "full", operator: true, restricted: false, installation: true, passwordSet: true,
  principal: { caller: "cookie", capability: "act", viewer: false, token: false }, unscopedConsole: false, demo: false };
const PERSONAS: Record<string, SectionPerson> = {
  operator: OPERATOR,
  "installation approver": { ...OPERATOR, name: "ines", operator: false },
  "project-limited approver": { ...OPERATOR, name: "lim", operator: false, restricted: true, installation: false },
  viewer: { ...OPERATOR, name: "vera", role: "viewer", operator: false, principal: { caller: "cookie", capability: "read", viewer: true, token: false } },
  "API token": { ...OPERATOR, via: "bearer", principal: { caller: "bearer", capability: "act", viewer: false, token: true } },
  // An operator's READ-ONLY API token: it reads, whatever its person's role (Codex F0 round 1, finding 1).
  "read-only token": { ...OPERATOR, via: "bearer", principal: { caller: "bearer", capability: "read", viewer: false, token: true } },
  "local owner": { ...OPERATOR, authority: "local-owner", passwordSet: false },
};
/** Who may read each General section today (settings-groups-ui.ts generalGroup and the access group's local mode at
 * 271c93e1), written out by hand. */
const READS: Record<string, readonly string[]> = {
  appearance: Object.keys(PERSONAS),
  "this-browser": ["operator", "installation approver", "project-limited approver", "viewer", "API token", "read-only token"],
  "your-password": ["operator", "installation approver", "project-limited approver", "viewer", "API token", "read-only token"],
  // Its facts are scoped (installation data, or the package's own version for an operator), so everyone is admitted.
  version: Object.keys(PERSONAS),
  advanced: Object.keys(PERSONAS),
  "local-mode": ["operator", "installation approver", "project-limited approver", "viewer", "local owner"],
};
const DEPS: GeneralDeps = { updatesVersion: () => "9.9.9", packageVersion: "9.9.9", firstResult: () => null, passwordless: () => true, localModeOn: () => true };

/** Every loader of every section a spy around the real one. */
function spied(impls: SectionImpls) {
  const calls: Record<string, { summary: ReturnType<typeof vi.fn>; detail: ReturnType<typeof vi.fn> | null }> = {};
  const out: Record<string, SectionImpl<unknown, unknown>> = {};
  for (const [id, impl] of Object.entries(impls) as [string, SectionImpl<unknown, unknown>][]) {
    const summary = vi.fn(impl.loadSummary), detail = impl.loadDetail === undefined ? null : vi.fn(impl.loadDetail);
    calls[id] = { summary, detail };
    out[id] = { ...impl, loadSummary: summary, ...(detail === null ? {} : { loadDetail: detail }) };
  }
  return { impls: out as unknown as SectionImpls, calls };
}
const base = (person: SectionPerson, advanced = false) => ({ person, project: null, now: new Date("2026-11-14T10:00:00Z"), prefs: { theme: "system" as const, accent: "#000000", advanced } });

describe("admission runs before any loader: a denied section is never read", () => {
  test.each(Object.entries(PERSONAS))("%s", (name, person) => {
    for (const asked of [{ section: null, open: false }, { section: "advanced", open: true }]) {
      const passwordless = vi.fn(() => true);
      const { impls, calls } = spied(generalSections({ ...DEPS, passwordless }));
      render(() => renderArea("general", impls, base(person), asked));
      for (const section of SETTINGS_SECTIONS.filter(one => one.area === "general")) {
        const admitted = READS[section.id]!.includes(name);
        expect(calls[section.id]!.summary, `${name} × ${section.id}`).toHaveBeenCalledTimes(admitted ? 1 : 0);
        // A detail is read only for the asked, opened section, and only when its summary was.
        expect(calls[section.id]!.detail?.mock.calls.length ?? 0, `${name} × ${section.id} detail`).toBe(admitted && asked.open && asked.section === section.id ? 1 : 0);
      }
      // Data scope: Passwordless's state is installation data, read only for a person whose scope includes it.
      expect(passwordless, name).toHaveBeenCalledTimes(["operator", "installation approver", "viewer", "API token", "read-only token"].includes(name) ? 1 : 0);
    }
  });

  // A section whose policy refuses a persona (role, browser only, project-limited, local owner) is never loaded either.
  const synthetic = (policy: Partial<SectionPolicy>, read: SectionDeclaration["read"] = []): SectionDeclaration =>
    ({ ...SETTINGS_SECTIONS.find(one => one.id === "appearance")!, id: "probe", policy: { ...PINNED["settings.group-general"]!, ...policy }, read });
  const ALL = Object.keys(PERSONAS);
  test.each([
    // The local owner of a laptop install is its operator; only rows not marked for it refuse it (below).
    ["an operator's section", synthetic({ role: "operator", roleBrowser: true }), null, ["operator", "local owner"]],
    ["an approver's section", synthetic({ role: "approver", roleBrowser: false }), null, ["operator", "installation approver", "project-limited approver", "API token", "read-only token", "local owner"]],
    ["instance access only", synthetic({ limited: "deny" }), null, ["operator", "installation approver", "viewer", "API token", "read-only token", "local owner"]],
    ["browser sign-ins only", synthetic({ callers: ["cookie"] }), null, ["operator", "installation approver", "project-limited approver", "viewer", "local owner"]],
    ["never the local owner", synthetic({ local: "deny" }), null, ["operator", "installation approver", "project-limited approver", "viewer", "API token", "read-only token"]],
    // The request's proven capability, not the account's role: a read-only token is refused where an act is needed.
    ["an act row", synthetic({ scope: "act" }), null, ["operator", "installation approver", "project-limited approver", "API token", "local owner"]],
    ["a step-up row", synthetic({ scope: "step-up", callers: ["cookie"] }), null, ["operator", "installation approver", "project-limited approver", "local owner"]],
    // A page that needs an open project: a browser session with none is never loaded (the console sends it to the
    // opener); a token reads by its own project header; with a project open, everyone.
    ["a page that needs a project, none open", synthetic({ needsProject: true }), null, ["API token", "read-only token"]],
    ["a page that needs a project, one open", synthetic({ needsProject: true }), "/w/a", ALL],
    ["a project collection, none open", synthetic({ limited: "collection" }), null, ["operator", "installation approver", "viewer", "API token", "read-only token", "local owner"]],
    // Project rules a section can't prove (a proposal's owner and room, a resource, an adapter) are refused outright.
    ["a proposal's limited rule", synthetic({ limited: "proposal", project: "proposal" }), "/w/a", []],
    ["a resource's limited rule", synthetic({ limited: "resource" }), "/w/a", []],
    ["an adapter's project", synthetic({ project: "adapter" }), "/w/a", []],
    ["a task's project", synthetic({ project: "task" }), "/w/a", []],
    ["installation settings", synthetic({}, ["installation"]), null, ["operator", "installation approver", "viewer", "API token", "read-only token", "local owner"]],
  ] as const)("%s", (_name, declaration, project, admitted) => {
    for (const [name, person] of Object.entries(PERSONAS)) {
      const loadSummary = vi.fn(() => ({}));
      render(() => renderArea("general", { probe: { loadSummary, render: () => joinHtml([]) } } as unknown as SectionImpls, { ...base(person), project }, { section: null, open: false }, [declaration]));
      expect(loadSummary, name).toHaveBeenCalledTimes((admitted as readonly string[]).includes(name) ? 1 : 0);
      expect(admitSection(declaration, person, project).ok, name).toBe((admitted as readonly string[]).includes(name));
    }
  });
  test("an unscoped console has no project opener, so a page needing a project is read with none open", () => {
    expect(admitSection(synthetic({ needsProject: true }), { ...OPERATOR, unscopedConsole: true }).ok).toBe(true);
    expect(admitSection(synthetic({ needsProject: true }), OPERATOR)).toEqual({ ok: false, why: "project" });
    expect(admitSection(synthetic({ scope: "act" }), PERSONAS["read-only token"]!)).toEqual({ ok: false, why: "scope" });
  });
  test("Version: an operator's browser session reads the package's own version with no installation data (no Telegram file)", () => {
    const updatesVersion = vi.fn(() => "9.9.9");
    const read = (person: SectionPerson) => render(() => text(renderArea("general", generalSections({ ...DEPS, updatesVersion, packageVersion: "1.2.3" }), base(person), { section: null, open: false }).sections));
    const operator = read({ ...OPERATOR, installation: false });
    expect(operator).toContain('data-section="version"');
    expect(operator).toContain("1.2.3");
    expect(updatesVersion).not.toHaveBeenCalled();
    // Anyone else without installation data has no version to see.
    expect(read({ ...PERSONAS["installation approver"]!, installation: false })).not.toContain('data-section="version"');
    expect(updatesVersion).not.toHaveBeenCalled();
  });
});

describe("what each persona reads and may do on General", () => {
  const page = (person: SectionPerson, advanced = false, open = false) => render(() => text(renderArea("general", generalSections(DEPS), base(person, advanced), { section: open ? "advanced" : null, open }).sections));
  test("a viewer keeps every read they have today; controls follow what they may change", () => {
    const viewer = page(PERSONAS["viewer"]!);
    for (const id of ["appearance", "this-browser", "your-password", "version", "advanced"]) expect(viewer).toContain(`data-section="${id}"`);
    expect(viewer).toContain("Forget now");
    expect(viewer).toContain('name="advanced" value="on"');
    // Installation data in scope for an unrestricted viewer, as today; an operator's act is not theirs.
    expect(viewer).toContain("/settings/passwordless");
    expect(viewer).not.toContain("Open updates");
    expect(viewer).not.toContain("/settings/change/local-mode");
  });
  test("an API token reads the page and changes nothing from it; a project-limited person never sees installation data", () => {
    const token = page(PERSONAS["API token"]!);
    expect(token).not.toContain("Forget now");
    expect(token).not.toContain('action="/settings/advanced"');
    expect(token).not.toContain('data-section="local-mode"');
    // An operator's links go only to an operator's browser session (those pages refuse a token).
    expect(token).not.toContain("Open updates");
    expect(page(PERSONAS["API token"]!, false, true)).not.toContain('href="/settings/monitoring"');
    const limited = page(PERSONAS["project-limited approver"]!);
    expect(limited).not.toContain('data-section="version"');
    expect(limited).not.toContain("/settings/passwordless");
  });
  test("an operator's full session turns local mode off on its change document; the local owner is offered a password", () => {
    expect(page(OPERATOR)).toContain('href="/settings/change/local-mode"');
    expect(page(OPERATOR)).toContain("Open updates");
    const owner = page(PERSONAS["local owner"]!);
    expect(owner).toContain("Set a password");
    expect(owner).not.toContain("/settings/change/local-mode");
    expect(owner).not.toContain('data-section="this-browser"');
  });
});

// ---- the canonical project and the session-bound check --------------------------------------------------------------

describe("one canonical project", () => {
  const deps = { projects: () => ["/w/a", "/w/b", "/w/hidden"], canOpen: (repo: string) => repo !== "/w/hidden" };
  const at = (query: string) => new URL(`http://x/settings/general${query}`);
  test("the requested project, else the session's, else none; two is a 400; unknown and foreign are the same 404", () => {
    expect(resolveSettingsProject(at("?repo=%2Fw%2Fb"), "/w/a", deps)).toEqual({ ok: true, project: "/w/b", requested: true });
    expect(resolveSettingsProject(at(""), "/w/a", deps)).toEqual({ ok: true, project: "/w/a", requested: false });
    expect(resolveSettingsProject(at(""), null, deps)).toEqual({ ok: true, project: null, requested: false });
    expect(resolveSettingsProject(at("?repo=%2Fw%2Fa&repo=%2Fw%2Fb"), "/w/a", deps)).toMatchObject({ ok: false, status: 400 });
    const unknown = resolveSettingsProject(at("?repo=%2Fnowhere"), "/w/a", deps), foreign = resolveSettingsProject(at("?repo=%2Fw%2Fhidden"), "/w/a", deps);
    expect(unknown).toEqual({ ok: false, status: 404, message: PROJECT_NOT_AVAILABLE });
    expect(foreign).toEqual(unknown);
    expect(resolveSettingsProject(at("?repo="), "/w/a", deps)).toEqual(unknown);
  });
  // The HELPER only: no handler calls it yet. The slices that move a session-bound act (P5 control/setup, P7 mode
  // sign/revoke) wire it into the POST and add the real two-tab submission over HTTP (see the F0 PR notes).
  test("the session-project helper: drawn for A, B opened since, refused with a way back to A", () => {
    const name = (repo: string) => repo.split("/").pop()!;
    // The form was drawn while A was open, and carries A.
    const drawnFor = ["/w/a"];
    expect(sessionProjectCheck(drawnFor, "/w/a", name)).toEqual({ ok: true, project: "/w/a" });
    // Another tab opens B: the same post is refused, naming both.
    const refused = sessionProjectCheck(drawnFor, "/w/b", name);
    expect(refused).toEqual({ ok: false, rendered: "/w/a", session: "/w/b", message: "a is no longer the open project (b is). Nothing changed." });
    expect(sessionProjectCheck(drawnFor, null, name)).toMatchObject({ ok: false, rendered: "/w/a", session: null });
    // A form naming none, or two, is refused too.
    expect(sessionProjectCheck([], "/w/a", name)).toMatchObject({ ok: false, rendered: null });
    expect(sessionProjectCheck(["/w/a", "/w/a"], "/w/a", name)).toMatchObject({ ok: false, rendered: null });
    expect(sessionProjectCheck([""], "/w/a", name)).toMatchObject({ ok: false });
    const recovery = render(() => htmlString(openProjectAgain("/w/a", "a", "/settings/general?section=x")));
    expect(recovery).toContain('action="/projects/select"');
    expect(recovery).toContain('name="path" value="/w/a"');
    expect(recovery).toContain('name="return" value="/settings/general?section=x"');
    expect(recovery).toContain("Open a");
  });
});

// ---- change documents ---------------------------------------------------------------------------------------------

describe("a change document", () => {
  test("shows its form only to a person who may make the change; nobody else's loaders run", () => {
    const ok = render(() => changeDocument("local-mode", generalSections(DEPS), base(OPERATOR), "Enter your password."));
    expect(ok.ok).toBe(true);
    const body = ok.ok ? htmlString(ok.body) : "";
    expect(body).toContain('action="/settings/local-mode/off"');
    expect(body).toMatch(/<input type="password" name="password" autocomplete="current-password" required>/);
    expect(body).toContain("Enter your password.");
    for (const name of ["installation approver", "viewer", "API token", "local owner", "project-limited approver"]) {
      const { impls, calls } = spied(generalSections(DEPS));
      const refused = render(() => changeDocument("local-mode", impls, base(PERSONAS[name]!), null));
      expect(refused, name).toMatchObject({ ok: false, status: 403 });
      expect(calls["local-mode"]!.summary, name).not.toHaveBeenCalled();
    }
    expect(render(() => changeDocument("appearance", generalSections(DEPS), base(OPERATOR), null))).toMatchObject({ ok: false, status: 404 });
    expect(render(() => changeDocument("nothing", generalSections(DEPS), base(OPERATOR), null))).toMatchObject({ ok: false, status: 404 });
    // Nothing to change: it says so, with the way back.
    const off = render(() => changeDocument("local-mode", generalSections({ ...DEPS, localModeOn: () => false }), base(OPERATOR), null));
    expect(off.ok && htmlString(off.body)).toContain("Local mode is off.");
    expect(off.ok && htmlString(off.body)).not.toContain('action="/settings/local-mode/off"');
  });
  test("the sign-in sanitizer keeps a change document's address with its repo and section; secret keys and region fetches never", () => {
    expect(loginReturn("/settings/change/local-mode?repo=%2Fw%2Fa&section=local-mode")).toBe("/settings/change/local-mode?repo=%2Fw%2Fa&section=local-mode");
    expect(loginReturn("/settings/change/local-mode?repo=r&token=t&password=p&csrf=c&api-key=k")).toBe("/settings/change/local-mode?repo=r");
    expect(loginReturn("/settings/change/local-mode?fragment=steps")).toBe("/");
    for (const path of ["/settings/change/", "/settings/change/a/b", "/settings/change/A", "/settings/change/%2e%2e", "/settings/x/y"]) expect(loginReturn(path), path).toBe("/");
    // What was admitted before still is.
    expect(loginReturn("/settings/general?section=advanced")).toBe("/settings/general?section=advanced");
    expect(loginReturn("/settings/computers")).toBe("/settings/computers");
  });
});

// ---- retired addresses --------------------------------------------------------------------------------------------

describe("retired Settings addresses", () => {
  test("each lands on its section with only its own keys, each named once, and no fragment", () => {
    for (const [id, retirement] of Object.entries(SETTINGS_RETIRED)) {
      const row = ROUTES.find(one => one.id === id)!;
      expect(row.retired, id).toBe(true);
      expect(RETIRED_ROUTES[id], id).toBeDefined();
      const url = new URL(`http://x${row.sample}?${[...retirement.keep.map(key => `${key}=v-${key}`), "token=t", "csrf=c", `${retirement.keep[0] ?? "said"}=again`].join("&")}`);
      const to = RETIRED_ROUTES[id]!(url);
      expect(to).not.toContain("#");
      const landed = new URL(to, "http://x");
      expect(landed.pathname).toBe(retirement.to);
      expect(landed.searchParams.get("section")).toBe(retirement.section);
      expect(landed.searchParams.has("token") || landed.searchParams.has("csrf")).toBe(false);
      // A key named twice is dropped, not chosen.
      if (retirement.keep[0] !== undefined) expect(landed.searchParams.has(retirement.keep[0])).toBe(false);
      for (const key of retirement.keep.slice(1)) expect(landed.searchParams.get(key)).toBe(`v-${key}`);
    }
    expect(settingsRetiredHref({ to: "/settings/general", section: "advanced", keep: ["said"], open: true }, new URL("http://x/settings/advanced?said=Saved"))).toBe("/settings/general?said=Saved&section=advanced&open=1");
    expect(askedSection(new URL("http://x/?section=advanced&open=1"))).toEqual({ section: "advanced", open: true });
    expect(askedSection(new URL("http://x/?section=advanced&section=version"))).toEqual({ section: null, open: false });
    expect(askedSection(new URL("http://x/?section=%3Cscript%3E"))).toEqual({ section: null, open: false });
  });

  test("every old #id a link in src names on General (or on a page retired into it) is on the page exactly once", () => {
    const page = render(() => text(renderArea("general", generalSections(DEPS), base(OPERATOR), { section: "advanced", open: true }).sections));
    const ids = new Set<string>(SETTINGS_SECTIONS.filter(one => one.area === "general").flatMap(one => [one.id, ...one.oldIds]));
    const retired = Object.entries(SETTINGS_RETIRED).filter(([, one]) => one.to === "/settings/general").map(([id]) => ROUTES.find(row => row.id === id)!.sample);
    const pages = ["/settings/general", ...retired].map(path => path.replace(/[/]/g, "\\/"));
    const link = new RegExp(`(?:${pages.join("|")})(?:\\?[^"'\`#\\s]*)?#([a-z][a-z0-9-]*)`, "g");
    const walk = (dir: string): string[] => readdirSync(dir).flatMap(name => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? walk(path) : /\.(ts|tsx|mjs)$/.test(name) && !/\.test\./.test(name) ? [path] : [];
    });
    for (const file of [...walk("src"), ...walk("scripts")]) for (const match of readFileSync(file, "utf8").matchAll(link)) ids.add(match[1]!);
    for (const target of Object.values(HUB_ANCHORS)) if (target.startsWith("/settings/general#")) ids.add(target.split("#")[1]!);
    expect(ids).toContain("appearance");
    for (const id of ids) expect(page.split(`id="${id}"`).length - 1, id).toBe(1);
  });
});

// ---- inventories ----------------------------------------------------------------------------------------------------

describe("the script and proof inventories", () => {
  test.each(SCRIPT_INVENTORY.map(row => [row.id, row] as const))("script %s: exported where it says, sent today by the page it names", async (_id, row) => {
    const module = await import(/* @vite-ignore */ `../${row.module.replace(/\.ts$/, ".js")}`) as Record<string, unknown>;
    expect(module[row.symbol], row.symbol).toBeDefined();
    expect(ROUTES.find(one => one.id === row.today)?.method, row.today).not.toBe("POST");
  });
  test("an area page drawn from the section table carries no page script", () => {
    expect(SETTINGS_SECTIONS.filter(one => one.area === "general").flatMap(one => one.scripts)).toEqual([]);
    const handler = /async function generalPage\([\s\S]*?\n {2}\}\n/.exec(readFileSync(new URL("./settings.ts", import.meta.url), "utf8"))![0];
    expect(handler).not.toContain("functional");
  });
  // A secret shown once (a worker's token, an invite link, an API token) is answered on its own sensitive document.
  const REVEALS: Record<string, { file: string; pins: RegExp[] }> = {
    "runner-register": { file: "./pages.ts", pins: [/if \(!authenticateCredential\(who, token\)\.ok\) return again\(/, /\{ chrome: chromeFor\(projectOf\(who, request\) \?\? null, "fleet"\), forceSensitive: true \}/] },
    "sessions-token": { file: "./people-tokens.ts", pins: [/screen\("API token", tokenShownHtml\(name, minted\.token, access, expiresAt\), \{ chrome: chromeFor\(projectOf\(who, request\) \?\? null, "settings"\), forceSensitive: true \}\)/] },
    "people-invite": { file: "./people-tokens.ts", pins: [/\{ chrome: chromeFor\(projectOf\(who, request\) \?\? null, "people"\), forceSensitive: true \}/] },
  };
  test("every one-time reveal is listed, and its handler answers on a sensitive document", () => {
    expect(PROOF_INVENTORY.filter(row => row.reveal === "once").map(row => row.id).sort()).toEqual(Object.keys(REVEALS).sort());
    for (const [id, { file, pins }] of Object.entries(REVEALS)) {
      const source = readFileSync(new URL(file, import.meta.url), "utf8");
      for (const pin of pins) expect(source, id).toMatch(pin);
    }
    expect(PROOF_INVENTORY.find(row => row.id === "runner-register")).toMatchObject({ proof: "credential", passwordless: "refused", sso: "accepted", routes: ["/fleet/runner/register"] });
    expect(PROOF_INVENTORY.find(row => row.id === "runner-retire")).toMatchObject({ proof: "step-up", routes: ["/fleet/runner/retire"] });
  });
});
